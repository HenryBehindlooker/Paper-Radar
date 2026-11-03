import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/index';
import { normalizeAuthorName } from '../db/merge';
import { jobState, matches, papers, sourceQueries, subscriptions } from '../db/schema';
import type { Logger } from '../log';
import { normalizeOrcid } from '../sources/normalize';
import {
	authorNameVariants,
	DEFAULT_RANKING,
	scoreMatch,
	type RankingConfig,
	type SubscriptionHit
} from './score';

/**
 * Matching: ordnet neue Paper den Abos zu und speichert pro Person und Paper genau
 * einen Treffer mit Score und Begründung.
 *
 *  A) Neue Paper seit dem letzten Lauf × alle Abos
 *  B) Neue Abos (noch nie gematcht) × vorhandene Paper der letzten 30 Tage
 *
 * Jedes deduplizierte Query wird nur einmal gegen die Datenbank ausgewertet und das
 * Ergebnis auf alle Abonnent:innen verteilt. Für jedes betroffene (Person, Paper)-Paar
 * werden immer alle Abos der Person berücksichtigt, sodass der Score vollständig ist.
 */

export const MATCHING_WATERMARK_KEY = 'matching.lastRunAt';
/** Zeitfenster für neue Abos bzw. den allerersten Lauf. */
export const INITIAL_WINDOW_DAYS = 30;
/**
 * Überlappung mit dem letzten Lauf: Ingestion-Transaktionen, die vor dem Wasserstand
 * begonnen, aber erst danach committet wurden, werden so nicht übersehen.
 * Wiederholtes Matching ist idempotent.
 */
export const WATERMARK_OVERLAP_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export interface MatchContext {
	db: Db;
	logger: Logger;
	now: () => Date;
	ranking?: RankingConfig;
}

export interface MatchRunResult {
	candidatePapers: number;
	newSubscriptions: number;
	matchesWritten: number;
}

interface QueryRef {
	id: number;
	type: 'keyword' | 'category' | 'author';
	query: string;
}

interface QueryHit {
	paperId: number;
	rank: number;
	inTitle: boolean;
}

/** Paper-Filter: konkrete IDs oder alles ab einem Zeitpunkt. */
type PaperFilter = { ids: readonly number[] } | { since: Date };

function filterSql(filter: PaperFilter, column: SQL): SQL {
	if ('ids' in filter) {
		return sql`${column} IN (SELECT jsonb_array_elements_text(${JSON.stringify(filter.ids)}::jsonb)::bigint)`;
	}
	return sql`${column} IN (SELECT id FROM papers WHERE published_at >= ${filter.since} OR first_seen_at >= ${filter.since})`;
}

/** Wertet ein dedupliziertes Query lokal aus (Volltext, Kategorie, Autor:in). */
export async function hitsForQuery(db: Db, q: QueryRef, filter: PaperFilter): Promise<QueryHit[]> {
	if ('ids' in filter && filter.ids.length === 0) return [];
	let result;
	switch (q.type) {
		case 'keyword':
			result = await db.execute<{ id: number; rank: number; in_title: boolean }>(sql`
				SELECT p.id, ts_rank_cd(p.search_vector, q) AS rank,
				       to_tsvector('english'::regconfig, left(p.title, 2000)) @@ q AS in_title
				FROM papers p, websearch_to_tsquery('english'::regconfig, ${q.query}) q
				WHERE p.search_vector @@ q AND ${filterSql(filter, sql`p.id`)}`);
			break;
		case 'category':
			result = await db.execute<{ id: number; rank: number; in_title: boolean }>(sql`
				SELECT p.id, 0 AS rank, false AS in_title FROM papers p
				WHERE p.categories @> ARRAY[${q.query}]::text[] AND ${filterSql(filter, sql`p.id`)}`);
			break;
		case 'author': {
			const orcid = normalizeOrcid(q.query);
			const authorCondition = orcid
				? sql`a.orcid = ${orcid}`
				: sql`a.name_normalized IN (SELECT jsonb_array_elements_text(${JSON.stringify(
						authorNameVariants(normalizeAuthorName(q.query))
					)}::jsonb))`;
			result = await db.execute<{ id: number; rank: number; in_title: boolean }>(sql`
				SELECT DISTINCT pa.paper_id AS id, 0 AS rank, false AS in_title
				FROM paper_authors pa JOIN authors a ON a.id = pa.author_id
				WHERE ${authorCondition} AND ${filterSql(filter, sql`pa.paper_id`)}`);
			break;
		}
	}
	return result.rows.map((r) => ({
		paperId: Number(r.id),
		rank: Number(r.rank),
		inTitle: Boolean(r.in_title)
	}));
}

interface SubRow {
	id: number;
	userId: string;
	type: 'keyword' | 'category' | 'author';
	query: string;
	weight: number;
	sourceQueryId: number;
	sourceQuery: string;
	initialMatchedAt: Date | null;
}

class HitCollector {
	/** userId → paperId → Treffer */
	readonly pairs = new Map<string, Map<number, SubscriptionHit[]>>();

	add(sub: SubRow, hit: QueryHit): void {
		let byPaper = this.pairs.get(sub.userId);
		if (!byPaper) this.pairs.set(sub.userId, (byPaper = new Map()));
		let list = byPaper.get(hit.paperId);
		if (!list) byPaper.set(hit.paperId, (list = []));
		if (list.some((h) => h.subscriptionId === sub.id)) return;
		list.push({
			subscriptionId: sub.id,
			type: sub.type,
			query: sub.query,
			weight: sub.weight,
			...(sub.type === 'keyword' ? { textRank: hit.rank, inTitle: hit.inTitle } : {})
		});
	}
}

async function readWatermark(db: Db): Promise<Date | null> {
	const [row] = await db
		.select({ value: jobState.value })
		.from(jobState)
		.where(eq(jobState.key, MATCHING_WATERMARK_KEY));
	const at = (row?.value as { at?: string } | undefined)?.at;
	return at ? new Date(at) : null;
}

async function writeWatermark(db: DbOrTx, at: Date): Promise<void> {
	await db
		.insert(jobState)
		.values({ key: MATCHING_WATERMARK_KEY, value: { at: at.toISOString() }, updatedAt: at })
		.onConflictDoUpdate({
			target: jobState.key,
			set: { value: { at: at.toISOString() }, updatedAt: at }
		});
}

export async function runMatching(ctx: MatchContext): Promise<MatchRunResult> {
	const { db } = ctx;
	const ranking = ctx.ranking ?? DEFAULT_RANKING;
	const runStart = ctx.now();
	const windowStart = new Date(runStart.getTime() - INITIAL_WINDOW_DAYS * DAY_MS);
	const watermark = await readWatermark(db);
	const lagged = watermark ? new Date(watermark.getTime() - WATERMARK_OVERLAP_MS) : null;
	const since = lagged && lagged > windowStart ? lagged : windowStart;

	const candidateRows = await db
		.select({ id: papers.id })
		.from(papers)
		.where(sql`${papers.firstSeenAt} > ${since} AND ${papers.firstSeenAt} <= ${runStart}`);
	const candidateIds = candidateRows.map((r) => r.id);

	const subs: SubRow[] = await db
		.select({
			id: subscriptions.id,
			userId: subscriptions.userId,
			type: subscriptions.type,
			query: subscriptions.query,
			weight: subscriptions.weight,
			sourceQueryId: subscriptions.sourceQueryId,
			sourceQuery: sourceQueries.query,
			initialMatchedAt: subscriptions.initialMatchedAt
		})
		.from(subscriptions)
		.innerJoin(sourceQueries, eq(sourceQueries.id, subscriptions.sourceQueryId));

	const subsByQuery = new Map<number, SubRow[]>();
	for (const s of subs) {
		const list = subsByQuery.get(s.sourceQueryId) ?? [];
		list.push(s);
		subsByQuery.set(s.sourceQueryId, list);
	}
	const queryOf = (s: SubRow): QueryRef => ({
		id: s.sourceQueryId,
		type: s.type,
		query: s.sourceQuery
	});

	const collector = new HitCollector();

	// A) neue Paper × alle Abos (jedes Query nur einmal auswerten)
	if (candidateIds.length > 0) {
		for (const list of subsByQuery.values()) {
			const first = list[0] as SubRow;
			const hits = await hitsForQuery(db, queryOf(first), { ids: candidateIds });
			for (const hit of hits) for (const sub of list) collector.add(sub, hit);
		}
	}

	// B) neue Abos × vorhandene Paper der letzten 30 Tage
	const newSubs = subs.filter((s) => s.initialMatchedAt === null);
	const candidateSet = new Set(candidateIds);
	const newByUser = new Map<string, SubRow[]>();
	for (const s of newSubs) newByUser.set(s.userId, [...(newByUser.get(s.userId) ?? []), s]);
	for (const [userId, userNewSubs] of newByUser) {
		const paperIds = new Set<number>();
		for (const sub of userNewSubs) {
			for (const hit of await hitsForQuery(db, queryOf(sub), { since: windowStart })) {
				if (!candidateSet.has(hit.paperId)) paperIds.add(hit.paperId);
			}
		}
		if (paperIds.size === 0) continue;
		// Für vollständige Scores alle Abos dieser Person gegen diese Paper auswerten.
		for (const sub of subs.filter((s) => s.userId === userId)) {
			for (const hit of await hitsForQuery(db, queryOf(sub), { ids: [...paperIds] })) {
				collector.add(sub, hit);
			}
		}
	}

	// Scoring und Speichern
	const involved = new Set<number>();
	for (const byPaper of collector.pairs.values()) for (const id of byPaper.keys()) involved.add(id);
	const published = new Map<number, Date>();
	if (involved.size > 0) {
		const rows = await db
			.select({ id: papers.id, publishedAt: papers.publishedAt })
			.from(papers)
			.where(inArray(papers.id, [...involved]));
		for (const r of rows) published.set(r.id, r.publishedAt);
	}

	const values: Array<typeof matches.$inferInsert> = [];
	for (const [userId, byPaper] of collector.pairs) {
		for (const [paperId, hits] of byPaper) {
			const publishedAt = published.get(paperId);
			if (!publishedAt) continue;
			const scored = scoreMatch(hits, publishedAt, runStart, ranking);
			if (!scored) continue;
			values.push({
				userId,
				paperId,
				score: scored.score,
				relevance: scored.relevance,
				reasons: scored.reasons,
				subscriptionIds: scored.subscriptionIds,
				createdAt: runStart
			});
		}
	}

	await db.transaction(async (tx) => {
		for (let i = 0; i < values.length; i += 500) {
			await tx
				.insert(matches)
				.values(values.slice(i, i + 500))
				.onConflictDoUpdate({
					target: [matches.userId, matches.paperId],
					// Gelesen/Gemerkt/Ausgeblendet bleiben erhalten.
					set: {
						score: sql`excluded.score`,
						relevance: sql`excluded.relevance`,
						reasons: sql`excluded.reasons`,
						subscriptionIds: sql`excluded.subscription_ids`
					}
				});
		}
		if (newSubs.length > 0) {
			await tx
				.update(subscriptions)
				.set({ initialMatchedAt: runStart })
				.where(
					and(
						inArray(
							subscriptions.id,
							newSubs.map((s) => s.id)
						),
						isNull(subscriptions.initialMatchedAt)
					)
				);
		}
		await writeWatermark(tx, runStart);
	});

	const result = {
		candidatePapers: candidateIds.length,
		newSubscriptions: newSubs.length,
		matchesWritten: values.length
	};
	ctx.logger.info('Matching fertig', { ...result });
	return result;
}

/**
 * SQL-Ausdruck für den Live-Score im Feed: Relevanz × Aktualitäts-Abfall zum Lesezeitpunkt.
 * `published_at` muss im Kontext verfügbar sein (Join auf `papers`).
 */
export function liveScoreSql(halfLifeDays: number, now: Date): SQL {
	return sql`(${matches.relevance} * power(0.5, GREATEST(0, extract(epoch FROM (${now}::timestamptz - ${papers.publishedAt})) / 86400.0) / ${halfLifeDays}))`;
}
