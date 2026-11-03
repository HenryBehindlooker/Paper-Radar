import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { logFetch } from '../db/fetch-log';
import { upsertPaper } from '../db/papers';
import { activeSourceQueries } from '../db/queries';
import { paperIds, papers, sourceQueries, sourceQueryStatus, type SourceQuery } from '../db/schema';
import {
	SourceDisabledError,
	SourceRateLimitedError,
	SourceBudgetExhaustedError
} from '../sources/errors';
import type { NormalizedPaper, PaperSource, SourceName } from '../sources/types';
import { DAY_MS, type JobContext } from './context';

/**
 * Ingestion-Jobs. Sie sind die einzige Stelle, die Upstream-APIs aufruft.
 * Jede Quelle wird für sich abgearbeitet; Fehler einer Quelle werden protokolliert
 * (fetch_log, source_query_status) und stoppen die anderen nicht.
 */

export interface StoreResult {
	paperIds: number[];
	newPaperIds: number[];
	failed: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Speichert Paper einzeln; ein fehlerhafter Datensatz bricht den Rest nicht ab. */
export async function storePapers(
	ctx: JobContext,
	list: readonly NormalizedPaper[]
): Promise<StoreResult> {
	const result: StoreResult = { paperIds: [], newPaperIds: [], failed: 0 };
	for (const paper of list) {
		try {
			const r = await upsertPaper(ctx.db, paper, ctx.now());
			result.paperIds.push(r.paperId);
			if (r.created) result.newPaperIds.push(r.paperId);
		} catch (error) {
			result.failed++;
			ctx.logger.warn('paper not stored', {
				source: paper.source,
				ids: paper.ids,
				error: errorMessage(error)
			});
		}
	}
	return result;
}

async function updateQueryStatus(
	ctx: JobContext,
	sourceQueryId: number,
	source: SourceName,
	outcome: { ok: true; coveredUntil: Date } | { ok: false; error: string }
): Promise<void> {
	const now = ctx.now();
	const values = outcome.ok
		? { lastRunAt: now, lastSuccessAt: now, coveredUntil: outcome.coveredUntil, lastError: null }
		: { lastRunAt: now, lastError: outcome.error.slice(0, 2000) };
	await ctx.db
		.insert(sourceQueryStatus)
		.values({ sourceQueryId, source, ...values })
		.onConflictDoUpdate({
			target: [sourceQueryStatus.sourceQueryId, sourceQueryStatus.source],
			set: outcome.ok
				? {
						...values,
						// Nie zurückdrehen (z. B. Backfill nach einem bereits weiter reichenden Lauf).
						coveredUntil: sql`GREATEST(${sourceQueryStatus.coveredUntil}, ${outcome.coveredUntil})`
					}
				: values
		});
	await ctx.db
		.update(sourceQueries)
		.set({ lastRunAt: now })
		.where(eq(sourceQueries.id, sourceQueryId));
}

// ---------------------------------------------------------------------------
// Täglich: arXiv-RSS für alle abonnierten Kategorien
// ---------------------------------------------------------------------------

export interface IngestSummary {
	newPaperIds: number[];
	errors: Array<{ source: SourceName; sourceQueryId?: number; message: string }>;
}

export async function ingestArxivDaily(ctx: JobContext): Promise<IngestSummary> {
	const startedAt = ctx.now();
	const queries = await activeSourceQueries(ctx.db, 'category');
	if (queries.length === 0) {
		await logFetch(ctx.db, {
			source: 'arxiv',
			kind: 'rss',
			startedAt,
			finishedAt: ctx.now(),
			status: 'skipped',
			detail: { reason: 'keine Kategorie-Abos' }
		});
		return { newPaperIds: [], errors: [] };
	}
	const categories = queries.map((q) => q.query);
	try {
		const items = await ctx.sources.arxiv.fetchDailyAnnouncements(categories);
		const stored = await storePapers(
			ctx,
			items.map((i) => i.paper)
		);
		for (const q of queries) {
			await updateQueryStatus(ctx, q.id, 'arxiv', { ok: true, coveredUntil: startedAt });
		}
		await logFetch(ctx.db, {
			source: 'arxiv',
			kind: 'rss',
			startedAt,
			finishedAt: ctx.now(),
			status: 'ok',
			itemCount: items.length,
			newPaperCount: stored.newPaperIds.length,
			detail: { categories: categories.length, failed: stored.failed }
		});
		return { newPaperIds: stored.newPaperIds, errors: [] };
	} catch (error) {
		const message = errorMessage(error);
		for (const q of queries)
			await updateQueryStatus(ctx, q.id, 'arxiv', { ok: false, error: message });
		await logFetch(ctx.db, {
			source: 'arxiv',
			kind: 'rss',
			startedAt,
			finishedAt: ctx.now(),
			status: 'error',
			error: message
		});
		return { newPaperIds: [], errors: [{ source: 'arxiv', message }] };
	}
}

// ---------------------------------------------------------------------------
// Täglich: Suche je dedupliziertem Query (Europe PMC; arXiv für Keyword/Autor)
// ---------------------------------------------------------------------------

export interface QueryIngestOptions {
	/** Überlappung mit dem letzten Fenster (spät indexierte Arbeiten). */
	overlapDays?: number;
	/** Zeitfenster für Queries, die noch nie liefen. */
	defaultLookbackDays?: number;
	/** Maximal so weit zurück, auch nach längerem Ausfall. */
	maxLookbackDays?: number;
	maxResultsPerQuery?: number;
}

/** Fehler, nach denen weitere Requests an dieselbe Quelle in diesem Lauf sinnlos sind. */
function stopsSource(error: unknown): boolean {
	return (
		error instanceof SourceRateLimitedError ||
		error instanceof SourceDisabledError ||
		error instanceof SourceBudgetExhaustedError
	);
}

async function runQueriesForSource(
	ctx: JobContext,
	source: PaperSource,
	queries: readonly SourceQuery[],
	opts: Required<QueryIngestOptions>,
	kind: 'search' | 'backfill',
	sinceFor: (q: SourceQuery) => Promise<Date>
): Promise<IngestSummary> {
	const summary: IngestSummary = { newPaperIds: [], errors: [] };
	for (const q of queries) {
		const startedAt = ctx.now();
		try {
			const since = await sinceFor(q);
			const found = await source.search({ kind: q.type, value: q.query }, since, {
				until: startedAt,
				maxResults: opts.maxResultsPerQuery
			});
			const stored = await storePapers(ctx, found);
			summary.newPaperIds.push(...stored.newPaperIds);
			await updateQueryStatus(ctx, q.id, source.name, { ok: true, coveredUntil: startedAt });
			await logFetch(ctx.db, {
				source: source.name,
				kind,
				sourceQueryId: q.id,
				startedAt,
				finishedAt: ctx.now(),
				status: 'ok',
				itemCount: found.length,
				newPaperCount: stored.newPaperIds.length,
				detail: { since: since.toISOString(), failed: stored.failed }
			});
		} catch (error) {
			const message = errorMessage(error);
			summary.errors.push({ source: source.name, sourceQueryId: q.id, message });
			await updateQueryStatus(ctx, q.id, source.name, { ok: false, error: message });
			await logFetch(ctx.db, {
				source: source.name,
				kind,
				sourceQueryId: q.id,
				startedAt,
				finishedAt: ctx.now(),
				status: 'error',
				error: message
			});
			ctx.logger.warn('query failed', { source: source.name, sourceQueryId: q.id, error: message });
			if (stopsSource(error)) break;
		}
	}
	return summary;
}

function withDefaults(opts: QueryIngestOptions): Required<QueryIngestOptions> {
	return {
		overlapDays: opts.overlapDays ?? 2,
		defaultLookbackDays: opts.defaultLookbackDays ?? 1,
		maxLookbackDays: opts.maxLookbackDays ?? 30,
		maxResultsPerQuery: opts.maxResultsPerQuery ?? 200
	};
}

/** Quellen, die für tägliche Suchen genutzt werden; arXiv-Kategorien laufen über RSS. */
function searchSources(
	ctx: JobContext
): Array<{ source: PaperSource; skip?: (q: SourceQuery) => boolean }> {
	return [
		{ source: ctx.sources.arxiv, skip: (q) => q.type === 'category' },
		{ source: ctx.sources.europepmc }
	];
}

export async function ingestSourceQueries(
	ctx: JobContext,
	options: QueryIngestOptions = {}
): Promise<IngestSummary> {
	const opts = withDefaults(options);
	const queries = await activeSourceQueries(ctx.db);
	const now = ctx.now();
	const floor = new Date(now.getTime() - opts.maxLookbackDays * DAY_MS);

	const runs = searchSources(ctx).map(({ source, skip }) => {
		const relevant = queries.filter(
			(q) => source.supportedQueryKinds.has(q.type) && !(skip?.(q) ?? false)
		);
		return runQueriesForSource(ctx, source, relevant, opts, 'search', async (q) => {
			const [status] = await ctx.db
				.select({ coveredUntil: sourceQueryStatus.coveredUntil })
				.from(sourceQueryStatus)
				.where(
					and(eq(sourceQueryStatus.sourceQueryId, q.id), eq(sourceQueryStatus.source, source.name))
				);
			const since = status?.coveredUntil
				? new Date(status.coveredUntil.getTime() - opts.overlapDays * DAY_MS)
				: new Date(now.getTime() - opts.defaultLookbackDays * DAY_MS);
			return since < floor ? floor : since;
		});
	});
	// Quellen laufen parallel (eigene Limiter); Fehler bleiben je Quelle isoliert.
	const results = await Promise.all(runs);
	return {
		newPaperIds: results.flatMap((r) => r.newPaperIds),
		errors: results.flatMap((r) => r.errors)
	};
}

// ---------------------------------------------------------------------------
// Backfill für neue Abos (letzte 30 Tage)
// ---------------------------------------------------------------------------

export async function backfillSourceQuery(
	ctx: JobContext,
	sourceQueryId: number,
	options: { days?: number; maxResults?: number } = {}
): Promise<IngestSummary & { status: 'done' | 'failed' | 'missing' }> {
	const days = Math.min(30, options.days ?? 30);
	const [q] = await ctx.db.select().from(sourceQueries).where(eq(sourceQueries.id, sourceQueryId));
	if (!q) return { newPaperIds: [], errors: [], status: 'missing' };

	await ctx.db
		.update(sourceQueries)
		.set({ backfillStatus: 'running', backfillError: null })
		.where(eq(sourceQueries.id, q.id));

	const since = new Date(ctx.now().getTime() - days * DAY_MS);
	const opts = withDefaults({ maxResultsPerQuery: options.maxResults ?? 500 });
	// Für den Backfill nutzt arXiv auch bei Kategorien die Such-API (RSS kennt nur den letzten Tag).
	const relevant = [ctx.sources.arxiv, ctx.sources.europepmc].filter((s) =>
		s.supportedQueryKinds.has(q.type)
	);
	const results = await Promise.all(
		relevant.map((source) =>
			runQueriesForSource(ctx, source, [q], opts, 'backfill', async () => since)
		)
	);
	const summary: IngestSummary = {
		newPaperIds: results.flatMap((r) => r.newPaperIds),
		errors: results.flatMap((r) => r.errors)
	};
	const failed = relevant.length > 0 && summary.errors.length >= relevant.length;
	await ctx.db
		.update(sourceQueries)
		.set({
			backfillStatus: failed ? 'failed' : 'done',
			backfillFinishedAt: ctx.now(),
			backfillError: summary.errors.length
				? summary.errors
						.map((e) => `${e.source}: ${e.message}`)
						.join('; ')
						.slice(0, 2000)
				: null
		})
		.where(eq(sourceQueries.id, q.id));
	return { ...summary, status: failed ? 'failed' : 'done' };
}

// ---------------------------------------------------------------------------
// Crossref-Ergänzung für neue DOIs
// ---------------------------------------------------------------------------

export async function enrichWithCrossref(
	ctx: JobContext,
	options: { limit?: number } = {}
): Promise<{ checked: number; found: number; error?: string }> {
	const startedAt = ctx.now();
	const rows = await ctx.db
		.select({ paperId: papers.id, doi: paperIds.value })
		.from(papers)
		.innerJoin(paperIds, and(eq(paperIds.paperId, papers.id), eq(paperIds.type, 'doi')))
		.where(isNull(papers.crossrefCheckedAt))
		.orderBy(desc(papers.firstSeenAt))
		.limit(options.limit ?? 200);
	if (rows.length === 0) return { checked: 0, found: 0 };

	try {
		const found = await ctx.sources.crossref.getByDois(rows.map((r) => r.doi));
		const stored = await storePapers(ctx, found);
		await ctx.db
			.update(papers)
			.set({ crossrefCheckedAt: ctx.now() })
			.where(inArray(papers.id, [...new Set([...rows.map((r) => r.paperId), ...stored.paperIds])]));
		await logFetch(ctx.db, {
			source: 'crossref',
			kind: 'lookup',
			startedAt,
			finishedAt: ctx.now(),
			status: 'ok',
			itemCount: found.length,
			newPaperCount: stored.newPaperIds.length,
			detail: { requested: rows.length }
		});
		return { checked: rows.length, found: found.length };
	} catch (error) {
		const message = errorMessage(error);
		await logFetch(ctx.db, {
			source: 'crossref',
			kind: 'lookup',
			startedAt,
			finishedAt: ctx.now(),
			status: 'error',
			error: message,
			detail: { requested: rows.length }
		});
		return { checked: 0, found: 0, error: message };
	}
}

// ---------------------------------------------------------------------------
// Aufräumen
// ---------------------------------------------------------------------------

export interface CleanupResult {
	papers: number;
	authors: number;
	sourceQueries: number;
	fetchLog: number;
}

/**
 * Löscht Paper ohne Treffer, die älter als `days` sind (veröffentlicht und bei uns
 * erfasst), verwaiste Autor:innen, Queries ohne Abo und alte Protokolleinträge.
 */
export async function cleanup(
	ctx: JobContext,
	options: { days?: number; fetchLogDays?: number } = {}
): Promise<CleanupResult> {
	const now = ctx.now();
	const cutoff = new Date(now.getTime() - (options.days ?? 180) * DAY_MS);
	const logCutoff = new Date(now.getTime() - (options.fetchLogDays ?? 90) * DAY_MS);
	const graceCutoff = new Date(now.getTime() - DAY_MS);

	return ctx.db.transaction(async (tx) => {
		const p = await tx.execute(sql`
			DELETE FROM papers p
			WHERE p.published_at < ${cutoff} AND p.first_seen_at < ${cutoff}
			  AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.paper_id = p.id)`);
		const a = await tx.execute(sql`
			DELETE FROM authors a
			WHERE NOT EXISTS (SELECT 1 FROM paper_authors pa WHERE pa.author_id = a.id)`);
		const q = await tx.execute(sql`
			DELETE FROM source_queries q
			WHERE q.created_at < ${graceCutoff}
			  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_query_id = q.id)`);
		const f = await tx.execute(sql`DELETE FROM fetch_log WHERE started_at < ${logCutoff}`);
		return {
			papers: p.rowCount ?? 0,
			authors: a.rowCount ?? 0,
			sourceQueries: q.rowCount ?? 0,
			fetchLog: f.rowCount ?? 0
		};
	});
}
