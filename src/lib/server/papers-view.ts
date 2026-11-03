import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PaperIdsView } from '../papers/links';
import type { MatchReason } from '../ranking/reasons';
import type { Db } from './db/index';
import { authors, matches, paperAuthors, paperIds, papers } from './db/schema';
import { liveScoreSql } from './ranking/match';

/**
 * Lesemodell für die Oberfläche: Feed, Suche, Merkliste, Detailseite.
 * Abstracts werden nur ausgeliefert, wenn die Lizenz die Anzeige erlaubt.
 */

export const PAGE_SIZE = 30;

export interface PaperCard {
	paperId: number;
	title: string;
	authors: string[];
	authorCount: number;
	publishedAt: Date;
	journal: string | null;
	abstract: string | null;
	sources: string[];
	categories: string[];
	landingUrl: string;
	ids: PaperIdsView;
	pdfUrl: string | null;
	citedByCount: number | null;
	reasons: MatchReason[];
	seen: boolean;
	saved: boolean;
	hidden: boolean;
	score: number | null;
}

export interface Page<T> {
	items: T[];
	page: number;
	hasMore: boolean;
}

interface Ranked {
	paperId: number;
	score: number | null;
}

/** Lädt Karten in der Reihenfolge von `ranked` inkl. Autoren, IDs und eigenem Status. */
export async function hydrateCards(
	db: Db,
	userId: string,
	ranked: readonly Ranked[],
	maxAuthors = 8
): Promise<PaperCard[]> {
	if (ranked.length === 0) return [];
	const ids = ranked.map((r) => r.paperId);
	const [rows, authorRows, idRows, states] = await Promise.all([
		db
			.select({
				id: papers.id,
				title: papers.title,
				publishedAt: papers.publishedAt,
				journal: papers.journal,
				abstract: sql<
					string | null
				>`CASE WHEN ${papers.abstractLicenseOk} THEN ${papers.abstract} END`,
				sources: papers.sources,
				categories: papers.categories,
				landingUrl: papers.landingUrl,
				pdfUrl: papers.pdfUrl,
				citedByCount: papers.citedByCount
			})
			.from(papers)
			.where(inArray(papers.id, ids)),
		db
			.select({ paperId: paperAuthors.paperId, name: authors.name })
			.from(paperAuthors)
			.innerJoin(authors, eq(authors.id, paperAuthors.authorId))
			.where(inArray(paperAuthors.paperId, ids))
			.orderBy(paperAuthors.paperId, paperAuthors.position),
		db.select().from(paperIds).where(inArray(paperIds.paperId, ids)),
		db
			.select({
				paperId: matches.paperId,
				reasons: matches.reasons,
				seen: matches.seen,
				saved: matches.saved,
				hidden: matches.hidden
			})
			.from(matches)
			.where(and(eq(matches.userId, userId), inArray(matches.paperId, ids)))
	]);

	const byId = new Map(rows.map((r) => [r.id, r]));
	const authorsBy = new Map<number, string[]>();
	for (const a of authorRows)
		authorsBy.set(a.paperId, [...(authorsBy.get(a.paperId) ?? []), a.name]);
	const idsBy = new Map<number, PaperIdsView>();
	const field: Record<string, keyof PaperIdsView> = {
		doi: 'doi',
		arxiv: 'arxivId',
		pmid: 'pmid',
		pmcid: 'pmcid',
		openalex: 'openalexId',
		europepmc: 'europepmcId'
	};
	for (const i of idRows) {
		const view = idsBy.get(i.paperId) ?? {};
		const key = field[i.type];
		if (key) view[key] = i.value;
		idsBy.set(i.paperId, view);
	}
	const stateBy = new Map(states.map((s) => [s.paperId, s]));

	const cards: PaperCard[] = [];
	for (const r of ranked) {
		const p = byId.get(r.paperId);
		if (!p) continue;
		const list = authorsBy.get(p.id) ?? [];
		const state = stateBy.get(p.id);
		cards.push({
			paperId: p.id,
			title: p.title,
			authors: list.slice(0, maxAuthors),
			authorCount: list.length,
			publishedAt: p.publishedAt,
			journal: p.journal,
			abstract: p.abstract,
			sources: p.sources,
			categories: p.categories,
			landingUrl: p.landingUrl,
			ids: idsBy.get(p.id) ?? {},
			pdfUrl: p.pdfUrl,
			citedByCount: p.citedByCount,
			reasons: (state?.reasons as MatchReason[] | undefined) ?? [],
			seen: state?.seen ?? false,
			saved: state?.saved ?? false,
			hidden: state?.hidden ?? false,
			score: r.score
		});
	}
	return cards;
}

function pageOf<T>(items: T[], page: number, size: number): Page<T> {
	return { items: items.slice(0, size), page, hasMore: items.length > size };
}

export type FeedFilter = 'alle' | 'ungelesen' | 'ausgeblendet';

export function parseFeedFilter(value: string | null): FeedFilter {
	return value === 'ungelesen' || value === 'ausgeblendet' ? value : 'alle';
}

export function parsePage(value: string | null): number {
	const n = Number(value);
	return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}

/**
 * Persönlicher Feed, sortiert nach Live-Score. Nur echte Abo-Treffer
 * (Einträge, die nur durch „Merken“ aus der Suche entstanden, erscheinen nicht).
 */
export async function feedPage(
	db: Db,
	userId: string,
	options: { now: Date; halfLifeDays: number; filter?: FeedFilter; page?: number; size?: number }
): Promise<Page<PaperCard>> {
	const size = options.size ?? PAGE_SIZE;
	const page = options.page ?? 1;
	const filter = options.filter ?? 'alle';
	const live = liveScoreSql(options.halfLifeDays, options.now);
	const conditions: SQL[] = [
		eq(matches.userId, userId),
		sql`jsonb_array_length(${matches.reasons}) > 0`,
		eq(matches.hidden, filter === 'ausgeblendet')
	];
	if (filter === 'ungelesen') conditions.push(eq(matches.seen, false));
	const ranked = await db
		.select({ paperId: matches.paperId, score: sql<number>`${live}` })
		.from(matches)
		.innerJoin(papers, eq(papers.id, matches.paperId))
		.where(and(...conditions))
		.orderBy(desc(live), desc(papers.publishedAt), desc(papers.id))
		.limit(size + 1)
		.offset((page - 1) * size);
	const cards = await hydrateCards(
		db,
		userId,
		ranked.map((r) => ({ paperId: r.paperId, score: Number(r.score) }))
	);
	return pageOf(cards, page, size);
}

/** Volltextsuche über alle gespeicherten Paper (Postgres-Websuche-Syntax). */
export async function searchPage(
	db: Db,
	userId: string,
	query: string,
	options: { page?: number; size?: number } = {}
): Promise<Page<PaperCard>> {
	const q = query.trim().slice(0, 300);
	const size = options.size ?? PAGE_SIZE;
	const page = options.page ?? 1;
	if (!q) return { items: [], page, hasMore: false };
	const result = await db.execute<{ id: number; rank: number }>(sql`
		SELECT p.id, ts_rank_cd(p.search_vector, q) AS rank
		FROM papers p, websearch_to_tsquery('english'::regconfig, ${q}) q
		WHERE p.search_vector @@ q
		ORDER BY rank DESC, p.published_at DESC, p.id DESC
		LIMIT ${size + 1} OFFSET ${(page - 1) * size}`);
	const cards = await hydrateCards(
		db,
		userId,
		result.rows.map((r) => ({ paperId: Number(r.id), score: Number(r.rank) }))
	);
	return pageOf(cards, page, size);
}

/** Merkliste (zuletzt gemerkt zuerst). `size: Infinity` für den Export. */
export async function savedPapers(
	db: Db,
	userId: string,
	options: { page?: number; size?: number } = {}
): Promise<Page<PaperCard>> {
	const size = options.size ?? PAGE_SIZE;
	const page = options.page ?? 1;
	const base = db
		.select({ paperId: matches.paperId })
		.from(matches)
		.innerJoin(papers, eq(papers.id, matches.paperId))
		.where(and(eq(matches.userId, userId), eq(matches.saved, true)))
		.orderBy(desc(matches.savedAt), desc(papers.publishedAt));
	const ranked = Number.isFinite(size)
		? await base.limit(size + 1).offset((page - 1) * size)
		: await base;
	const cards = await hydrateCards(
		db,
		userId,
		ranked.map((r) => ({ paperId: r.paperId, score: null })),
		Number.POSITIVE_INFINITY
	);
	return Number.isFinite(size)
		? pageOf(cards, page, size)
		: { items: cards, page: 1, hasMore: false };
}

export async function paperDetail(
	db: Db,
	userId: string,
	paperId: number
): Promise<PaperCard | null> {
	const [card] = await hydrateCards(
		db,
		userId,
		[{ paperId, score: null }],
		Number.POSITIVE_INFINITY
	);
	return card ?? null;
}

export type PaperStateField = 'seen' | 'saved' | 'hidden';

export function parseStateField(value: unknown): PaperStateField | null {
	return value === 'seen' || value === 'saved' || value === 'hidden' ? value : null;
}

/**
 * Setzt gelesen/gemerkt/ausgeblendet. Für Paper ohne Abo-Treffer (z. B. aus der Suche
 * gemerkt) wird ein Eintrag ohne Begründung angelegt; er erscheint nicht im Feed.
 * Gibt `false` zurück, wenn das Paper nicht existiert.
 */
export async function setPaperState(
	db: Db,
	userId: string,
	paperId: number,
	field: PaperStateField,
	value: boolean
): Promise<boolean> {
	const [exists] = await db.select({ id: papers.id }).from(papers).where(eq(papers.id, paperId));
	if (!exists) return false;
	const savedAt = field === 'saved' ? (value ? new Date() : null) : undefined;
	await db
		.insert(matches)
		.values({
			userId,
			paperId,
			score: 0,
			relevance: 0,
			[field]: value,
			...(savedAt !== undefined ? { savedAt } : {})
		})
		.onConflictDoUpdate({
			target: [matches.userId, matches.paperId],
			set: { [field]: value, ...(savedAt !== undefined ? { savedAt } : {}) }
		});
	return true;
}
