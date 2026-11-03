import { eq, sql } from 'drizzle-orm';
import type { DbOrTx, Db } from '../db/index';
import { logFetch } from '../db/fetch-log';
import { upsertPaper } from '../db/papers';
import { openalexUsage, papers } from '../db/schema';
import type { Logger } from '../log';
import {
	SourceBudgetExhaustedError,
	SourceDisabledError,
	SourceRateLimitedError
} from '../sources/errors';
import type { OpenAlexSource } from '../sources/openalex';
import type { IdRef } from '../sources/types';
import {
	checkBudget,
	nextUtcMidnight,
	utcDay,
	type DayUsage,
	type OpenAlexBudgetConfig,
	type OpenAlexUsageTracker
} from './budget';

/**
 * Wöchentliche OpenAlex-Anreicherung: Zitationszahlen (und Autoren-IDs) für gemerkte und
 * gut gerankte Paper – ausschließlich per Einzelabruf. Vor jedem Request wird das
 * Tagesbudget geprüft; ist es erreicht, pausiert der Job sauber und meldet, wann er
 * fortgesetzt werden kann (nächste Mitternacht UTC).
 */

const DAY_MS = 86_400_000;
const RECENT_DAYS = 30;
const FLUSH_EVERY = 25;
const MAX_CANDIDATES = 10_000;

export interface EnrichContext {
	db: Db;
	logger: Logger;
	now: () => Date;
	openalex: Pick<OpenAlexSource, 'getById' | 'enabled'>;
	tracker: OpenAlexUsageTracker;
	budget: OpenAlexBudgetConfig;
}

export interface EnrichResult {
	status: 'done' | 'paused' | 'disabled';
	reason?: 'credits' | 'requests' | 'remaining' | 'server' | 'rate-limit';
	checked: number;
	updated: number;
	notFound: number;
	failed: number;
	/** Noch offene Kandidaten (bei Pause). */
	remaining: number;
	resumeAt?: Date;
}

export interface Candidate {
	paperId: number;
	ref: IdRef;
}

/**
 * Kandidaten: von jemandem gemerkt, oder in den letzten 30 Tagen mit Relevanz ≥ Schwelle
 * getroffen; mit DOI, OpenAlex-ID oder PMID; nicht in den letzten `refreshDays` geprüft.
 * Gemerkte zuerst, dann nach höchster Relevanz.
 */
export async function selectCandidates(
	db: DbOrTx,
	now: Date,
	budget: OpenAlexBudgetConfig,
	limit: number
): Promise<Candidate[]> {
	const recent = new Date(now.getTime() - RECENT_DAYS * DAY_MS);
	const stale = new Date(now.getTime() - budget.refreshDays * DAY_MS);
	const result = await db.execute<{
		id: number;
		openalex: string | null;
		doi: string | null;
		pmid: string | null;
	}>(sql`
		SELECT p.id,
			(SELECT value FROM paper_ids WHERE paper_id = p.id AND type = 'openalex' LIMIT 1) AS openalex,
			(SELECT value FROM paper_ids WHERE paper_id = p.id AND type = 'doi' LIMIT 1) AS doi,
			(SELECT value FROM paper_ids WHERE paper_id = p.id AND type = 'pmid' LIMIT 1) AS pmid
		FROM papers p
		JOIN matches m ON m.paper_id = p.id
		WHERE (m.saved OR (m.relevance >= ${budget.minRelevance} AND m.created_at >= ${recent}))
		  AND (p.openalex_checked_at IS NULL OR p.openalex_checked_at < ${stale})
		  AND EXISTS (SELECT 1 FROM paper_ids i WHERE i.paper_id = p.id AND i.type IN ('openalex', 'doi', 'pmid'))
		GROUP BY p.id
		ORDER BY bool_or(m.saved) DESC, max(m.relevance) DESC, p.id
		LIMIT ${limit}`);
	return result.rows.map((r) => {
		const ref: IdRef = r.openalex
			? { type: 'openalex', value: r.openalex }
			: r.doi
				? { type: 'doi', value: r.doi }
				: { type: 'pmid', value: r.pmid as string };
		return { paperId: Number(r.id), ref };
	});
}

/** Schreibt gesammelten Verbrauch in `openalex_usage` (additiv je Tag). */
export async function persistUsage(
	db: DbOrTx,
	tracker: OpenAlexUsageTracker,
	now: Date
): Promise<void> {
	for (const [day, u] of tracker.drain()) {
		await db
			.insert(openalexUsage)
			.values({
				day,
				requests: u.requests,
				credits: u.credits,
				lastRemaining: u.lastRemaining,
				updatedAt: now
			})
			.onConflictDoUpdate({
				target: openalexUsage.day,
				set: {
					requests: sql`${openalexUsage.requests} + ${u.requests}`,
					credits: sql`${openalexUsage.credits} + ${u.credits}`,
					lastRemaining: u.lastRemaining ?? sql`${openalexUsage.lastRemaining}`,
					updatedAt: now
				}
			});
	}
}

async function usageToday(
	db: DbOrTx,
	tracker: OpenAlexUsageTracker,
	day: string
): Promise<DayUsage> {
	const [row] = await db.select().from(openalexUsage).where(eq(openalexUsage.day, day));
	const pending = tracker.pending(day);
	return {
		requests: (row?.requests ?? 0) + pending.requests,
		credits: (row?.credits ?? 0) + pending.credits,
		lastRemaining: pending.lastRemaining ?? row?.lastRemaining ?? null
	};
}

/** OpenAlex-IDs bekannter Autor:innen per ORCID nachtragen (keine neuen Datensätze). */
async function linkAuthorIds(
	db: DbOrTx,
	authors: ReadonlyArray<{ orcid?: string; openalexId?: string }>
) {
	for (const a of authors) {
		if (!a.orcid || !a.openalexId) continue;
		await db.execute(sql`
			UPDATE authors SET openalex_id = ${a.openalexId}
			WHERE orcid = ${a.orcid} AND openalex_id IS NULL
			  AND NOT EXISTS (SELECT 1 FROM authors WHERE openalex_id = ${a.openalexId})`);
	}
}

export async function enrichWithOpenAlex(ctx: EnrichContext): Promise<EnrichResult> {
	const startedAt = ctx.now();
	const result: EnrichResult = {
		status: 'done',
		checked: 0,
		updated: 0,
		notFound: 0,
		failed: 0,
		remaining: 0
	};

	if (!ctx.openalex.enabled) {
		result.status = 'disabled';
		await logFetch(ctx.db, {
			source: 'openalex',
			kind: 'enrich',
			startedAt,
			finishedAt: ctx.now(),
			status: 'skipped',
			detail: { reason: 'OPENALEX_API_KEY nicht gesetzt' }
		});
		ctx.logger.info('OpenAlex-Anreicherung übersprungen: kein API-Key');
		return result;
	}

	// Alle fälligen Kandidaten laden (nicht nur so viele, wie das Budget erlaubt), damit bei
	// einer Pause bekannt ist, dass noch etwas offen ist und fortgesetzt werden muss.
	const candidates = await selectCandidates(ctx.db, startedAt, ctx.budget, MAX_CANDIDATES);
	const pause = (reason: NonNullable<EnrichResult['reason']>, index: number) => {
		result.status = 'paused';
		result.reason = reason;
		result.remaining = candidates.length - index;
		result.resumeAt = nextUtcMidnight(ctx.now());
	};

	try {
		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i] as Candidate;
			const now = ctx.now();
			const decision = checkBudget(await usageToday(ctx.db, ctx.tracker, utcDay(now)), ctx.budget);
			if (!decision.ok) {
				pause(decision.reason, i);
				break;
			}
			let found;
			try {
				found = await ctx.openalex.getById(candidate.ref);
			} catch (error) {
				if (error instanceof SourceBudgetExhaustedError) {
					pause('server', i);
					break;
				}
				if (error instanceof SourceRateLimitedError) {
					pause('rate-limit', i);
					result.resumeAt = new Date(ctx.now().getTime() + error.retryAfterMs);
					break;
				}
				if (error instanceof SourceDisabledError) {
					result.status = 'disabled';
					break;
				}
				result.failed++;
				ctx.logger.warn('OpenAlex-Abruf fehlgeschlagen', {
					paperId: candidate.paperId,
					error: error instanceof Error ? error.message : String(error)
				});
				continue;
			}

			result.checked++;
			let paperId = candidate.paperId;
			const work = found[0];
			if (work) {
				const stored = await upsertPaper(ctx.db, work, now);
				paperId = stored.paperId;
				await linkAuthorIds(ctx.db, work.authors);
				result.updated++;
			} else {
				result.notFound++;
			}
			await ctx.db
				.update(papers)
				.set({ openalexCheckedAt: now })
				.where(sql`${papers.id} IN (${candidate.paperId}, ${paperId})`);
			if (result.checked % FLUSH_EVERY === 0) await persistUsage(ctx.db, ctx.tracker, now);
		}
	} finally {
		await persistUsage(ctx.db, ctx.tracker, ctx.now());
	}

	await logFetch(ctx.db, {
		source: 'openalex',
		kind: 'enrich',
		startedAt,
		finishedAt: ctx.now(),
		status: result.failed > 0 && result.checked === 0 ? 'error' : 'ok',
		itemCount: result.checked,
		detail: { ...result, resumeAt: result.resumeAt?.toISOString() }
	});
	ctx.logger.info('OpenAlex-Anreicherung', { ...result });
	return result;
}
