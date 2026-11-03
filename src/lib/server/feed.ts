import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { MatchReason } from '../ranking/reasons';
import type { Db } from './db/index';
import { authors, matches, paperAuthors, papers } from './db/schema';
import { liveScoreSql } from './ranking/match';

export interface FeedItem {
	paperId: number;
	title: string;
	authors: string[];
	authorCount: number;
	publishedAt: Date;
	landingUrl: string;
	journal: string | null;
	/** Abstract nur, wenn die Lizenz die Anzeige erlaubt. */
	abstract: string | null;
	sources: string[];
	score: number;
	reasons: MatchReason[];
	seen: boolean;
	saved: boolean;
}

/**
 * Treffer einer Person, sortiert nach Live-Score (Relevanz × aktueller Aktualitäts-Abfall).
 * Ausgeblendete Treffer werden nicht geliefert.
 */
export async function feedForUser(
	db: Db,
	userId: string,
	options: { now: Date; halfLifeDays: number; limit?: number; maxAuthors?: number }
): Promise<FeedItem[]> {
	const live = liveScoreSql(options.halfLifeDays, options.now);
	const rows = await db
		.select({
			paperId: papers.id,
			title: papers.title,
			publishedAt: papers.publishedAt,
			landingUrl: papers.landingUrl,
			journal: papers.journal,
			abstract: sql<
				string | null
			>`CASE WHEN ${papers.abstractLicenseOk} THEN ${papers.abstract} ELSE NULL END`,
			sources: papers.sources,
			score: sql<number>`${live}`,
			reasons: matches.reasons,
			seen: matches.seen,
			saved: matches.saved
		})
		.from(matches)
		.innerJoin(papers, eq(papers.id, matches.paperId))
		.where(and(eq(matches.userId, userId), eq(matches.hidden, false)))
		.orderBy(desc(live), desc(papers.publishedAt))
		.limit(options.limit ?? 50);

	const ids = rows.map((r) => r.paperId);
	const authorRows =
		ids.length === 0
			? []
			: await db
					.select({
						paperId: paperAuthors.paperId,
						name: authors.name,
						position: paperAuthors.position
					})
					.from(paperAuthors)
					.innerJoin(authors, eq(authors.id, paperAuthors.authorId))
					.where(inArray(paperAuthors.paperId, ids))
					.orderBy(paperAuthors.paperId, paperAuthors.position);
	const byPaper = new Map<number, string[]>();
	for (const a of authorRows) byPaper.set(a.paperId, [...(byPaper.get(a.paperId) ?? []), a.name]);

	const maxAuthors = options.maxAuthors ?? 5;
	return rows.map((r) => {
		const list = byPaper.get(r.paperId) ?? [];
		return {
			...r,
			score: Number(r.score),
			reasons: r.reasons as MatchReason[],
			authors: list.slice(0, maxAuthors),
			authorCount: list.length
		};
	});
}
