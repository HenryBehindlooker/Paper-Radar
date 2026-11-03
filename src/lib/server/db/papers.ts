import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Author, NormalizedPaper } from '../sources/types';
import type { Db, DbOrTx } from './index';
import {
	facetFromPaper,
	idEntries,
	mergeFacets,
	normalizeAuthorName,
	type IdEntry,
	type PaperFacet
} from './merge';
import { authors, matches, paperAuthors, paperIds, papers, type Paper } from './schema';

export interface UpsertResult {
	paperId: number;
	created: boolean;
	/** IDs von Datensätzen, die in `paperId` aufgegangen sind. */
	mergedPaperIds: number[];
}

function facetFromRow(row: Paper, authorCount: number): PaperFacet {
	return {
		metadataSource: row.metadataSource,
		title: row.title,
		abstract: row.abstract,
		abstractLicenseOk: row.abstractLicenseOk,
		abstractSource: row.abstractSource,
		sources: row.sources,
		categories: row.categories,
		journal: row.journal,
		landingUrl: row.landingUrl,
		pdfUrl: row.pdfUrl,
		publishedAt: row.publishedAt,
		sourceUpdatedAt: row.sourceUpdatedAt,
		citedByCount: row.citedByCount,
		authorCount
	};
}

function facetColumns(f: PaperFacet) {
	return {
		metadataSource: f.metadataSource,
		title: f.title,
		abstract: f.abstract,
		abstractLicenseOk: f.abstractLicenseOk,
		abstractSource: f.abstractSource,
		sources: f.sources,
		categories: f.categories,
		journal: f.journal,
		landingUrl: f.landingUrl,
		pdfUrl: f.pdfUrl,
		publishedAt: f.publishedAt,
		sourceUpdatedAt: f.sourceUpdatedAt,
		citedByCount: f.citedByCount
	};
}

/** Sperrt die IDs in fester Reihenfolge (verhindert Dubletten bei paralleler Ingestion). */
async function lockIds(tx: DbOrTx, entries: IdEntry[]): Promise<void> {
	for (const e of entries) {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paper:${e.type}:${e.value}`}, 0))`
		);
	}
}

async function authorCount(tx: DbOrTx, paperId: number): Promise<number> {
	const [row] = await tx
		.select({ n: sql<number>`count(*)::int` })
		.from(paperAuthors)
		.where(eq(paperAuthors.paperId, paperId));
	return row?.n ?? 0;
}

/** Legt Autor:innen an bzw. findet sie (Dedup über ORCID, sonst normalisierten Namen). */
export async function upsertAuthors(tx: DbOrTx, list: readonly Author[]): Promise<number[]> {
	const ids: number[] = [];
	for (const a of list) {
		const name = a.name.trim();
		const nameNormalized = normalizeAuthorName(name);
		if (!nameNormalized) continue;
		let id: number | undefined;
		if (a.orcid) {
			const [row] = await tx
				.insert(authors)
				.values({ name, nameNormalized, orcid: a.orcid })
				.onConflictDoUpdate({ target: authors.orcid, set: { name, nameNormalized } })
				.returning({ id: authors.id });
			id = row?.id;
		} else {
			const [row] = await tx
				.insert(authors)
				.values({ name, nameNormalized })
				.onConflictDoUpdate({
					target: authors.nameNormalized,
					targetWhere: sql`orcid IS NULL`,
					set: { nameNormalized }
				})
				.returning({ id: authors.id });
			id = row?.id;
		}
		if (id === undefined) continue;
		if (a.openalexId) {
			// OpenAlex-ID nur setzen, wenn sie noch keinem anderen Datensatz gehört.
			await tx.execute(sql`
				UPDATE authors SET openalex_id = ${a.openalexId}
				WHERE id = ${id} AND openalex_id IS NULL
				  AND NOT EXISTS (SELECT 1 FROM authors WHERE openalex_id = ${a.openalexId})`);
		}
		ids.push(id);
	}
	return ids;
}

async function replaceAuthors(tx: DbOrTx, paperId: number, list: readonly Author[]) {
	const authorIds = await upsertAuthors(tx, list);
	await tx.delete(paperAuthors).where(eq(paperAuthors.paperId, paperId));
	if (authorIds.length > 0) {
		await tx
			.insert(paperAuthors)
			.values(authorIds.map((authorId, position) => ({ paperId, position, authorId })));
	}
}

/** Führt `loserId` in `survivorId` zusammen (IDs, Treffer, ggf. Autoren) und löscht ihn. */
async function absorbPaper(tx: DbOrTx, survivor: Paper, loser: Paper): Promise<Paper> {
	const survivorAuthors = await authorCount(tx, survivor.id);
	const loserAuthors = await authorCount(tx, loser.id);
	const { facet, takeIncomingAuthors } = mergeFacets(
		facetFromRow(survivor, survivorAuthors),
		facetFromRow(loser, loserAuthors)
	);

	await tx.update(paperIds).set({ paperId: survivor.id }).where(eq(paperIds.paperId, loser.id));
	// Treffer zusammenführen: Flags verodern, besseren Score behalten.
	await tx.execute(sql`
		INSERT INTO matches (user_id, paper_id, score, subscription_ids, seen, saved, hidden, created_at)
		SELECT user_id, ${survivor.id}, score, subscription_ids, seen, saved, hidden, created_at
		FROM matches WHERE paper_id = ${loser.id}
		ON CONFLICT (user_id, paper_id) DO UPDATE SET
			score = GREATEST(matches.score, EXCLUDED.score),
			subscription_ids = ARRAY(SELECT DISTINCT unnest(matches.subscription_ids || EXCLUDED.subscription_ids)),
			seen = matches.seen OR EXCLUDED.seen,
			saved = matches.saved OR EXCLUDED.saved,
			hidden = matches.hidden OR EXCLUDED.hidden,
			created_at = LEAST(matches.created_at, EXCLUDED.created_at)`);
	await tx.delete(matches).where(eq(matches.paperId, loser.id));
	if (takeIncomingAuthors) {
		await tx.delete(paperAuthors).where(eq(paperAuthors.paperId, survivor.id));
		await tx
			.update(paperAuthors)
			.set({ paperId: survivor.id })
			.where(eq(paperAuthors.paperId, loser.id));
	}
	await tx.delete(papers).where(eq(papers.id, loser.id));

	const [updated] = await tx
		.update(papers)
		.set({
			...facetColumns(facet),
			firstSeenAt:
				loser.firstSeenAt < survivor.firstSeenAt ? loser.firstSeenAt : survivor.firstSeenAt,
			citedByUpdatedAt: survivor.citedByUpdatedAt ?? loser.citedByUpdatedAt,
			crossrefCheckedAt: survivor.crossrefCheckedAt ?? loser.crossrefCheckedAt
		})
		.where(eq(papers.id, survivor.id))
		.returning();
	return updated as Paper;
}

async function upsertPaperInTx(
	tx: DbOrTx,
	paper: NormalizedPaper,
	now: Date
): Promise<UpsertResult> {
	const entries = idEntries(paper.ids);
	if (entries.length === 0)
		throw new Error('Paper ohne Identifikator kann nicht gespeichert werden');
	await lockIds(tx, entries);

	const existingIds = await tx
		.selectDistinct({ paperId: paperIds.paperId })
		.from(paperIds)
		.where(
			sql`(${paperIds.type}, ${paperIds.value}) IN (${sql.join(
				entries.map((e) => sql`(${e.type}::paper_id_type, ${e.value})`),
				sql`, `
			)})`
		);

	const incoming = facetFromPaper(paper);

	if (existingIds.length === 0) {
		const [row] = await tx
			.insert(papers)
			.values({ ...facetColumns(incoming), firstSeenAt: now, lastSeenAt: now })
			.returning({ id: papers.id });
		const paperId = (row as { id: number }).id;
		await tx
			.insert(paperIds)
			.values(entries.map((e) => ({ ...e, paperId })))
			.onConflictDoNothing();
		await replaceAuthors(tx, paperId, paper.authors);
		return { paperId, created: true, mergedPaperIds: [] };
	}

	const rows = await tx
		.select()
		.from(papers)
		.where(
			inArray(
				papers.id,
				existingIds.map((r) => r.paperId)
			)
		)
		.orderBy(asc(papers.id));
	let survivor = rows[0] as Paper;
	const mergedPaperIds: number[] = [];
	for (const loser of rows.slice(1)) {
		survivor = await absorbPaper(tx, survivor, loser);
		mergedPaperIds.push(loser.id);
	}

	const { facet, takeIncomingAuthors } = mergeFacets(
		facetFromRow(survivor, await authorCount(tx, survivor.id)),
		incoming
	);
	await tx
		.update(papers)
		.set({
			...facetColumns(facet),
			lastSeenAt: now,
			...(paper.citedByCount !== undefined ? { citedByUpdatedAt: now } : {})
		})
		.where(eq(papers.id, survivor.id));
	await tx
		.insert(paperIds)
		.values(entries.map((e) => ({ ...e, paperId: survivor.id })))
		.onConflictDoNothing();
	if (takeIncomingAuthors) await replaceAuthors(tx, survivor.id, paper.authors);

	return { paperId: survivor.id, created: false, mergedPaperIds };
}

/**
 * Speichert ein normalisiertes Paper. Gleiche DOI, arXiv-ID (oder andere ID) → ein Datensatz.
 * Verbindet ein neuer Datensatz zwei bisher getrennte (z. B. arXiv-Preprint und
 * Verlagsversion über die nachträglich bekannte DOI), werden sie zusammengeführt.
 */
export async function upsertPaper(
	db: Db,
	paper: NormalizedPaper,
	now: Date = new Date()
): Promise<UpsertResult> {
	return db.transaction((tx) => upsertPaperInTx(tx, paper, now));
}

/** Findet ein Paper über eine beliebige ID. */
export async function findPaperIdBy(db: DbOrTx, type: IdEntry['type'], value: string) {
	const [row] = await db
		.select({ paperId: paperIds.paperId })
		.from(paperIds)
		.where(and(eq(paperIds.type, type), eq(paperIds.value, value)));
	return row?.paperId;
}
