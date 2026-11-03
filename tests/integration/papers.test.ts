import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { findPaperIdBy, upsertPaper } from '$lib/server/db/papers';
import { authors, matches, paperAuthors, paperIds, papers } from '$lib/server/db/schema';
import { parseArxivAtom } from '$lib/server/sources/arxiv';
import { normalizeCrossrefWork, type CrossrefWork } from '$lib/server/sources/crossref';
import { parseEuropePmcSearch } from '$lib/server/sources/europepmc';
import { fixture } from '../unit/sources/helpers';
import {
	closeTestDatabase,
	createUser,
	hasTestDb,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

const now = new Date('2026-11-03T12:00:00Z');

describe.skipIf(!hasTestDb)('Papers: Speichern, Dedup und Merge', () => {
	let database: Database;
	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => resetDatabase(database.db));
	afterAll(closeTestDatabase);

	const count = async () =>
		(await database.db.select({ n: sql<number>`count(*)::int` }).from(papers))[0]?.n;

	it('legt ein neues Paper mit IDs, Autoren und Suchvektor an', async () => {
		const p = makePaper({
			ids: { arxivId: '2611.01109', doi: '10.1000/x.1' },
			authors: [{ name: 'Rui Yang', orcid: '0009-0003-5839-1059' }, { name: 'Ada Lovelace' }]
		});
		const r = await upsertPaper(database.db, p, now);
		expect(r.created).toBe(true);
		const ids = await database.db.select().from(paperIds).where(eq(paperIds.paperId, r.paperId));
		expect(ids.map((i) => `${i.type}:${i.value}`).sort()).toEqual([
			'arxiv:2611.01109',
			'doi:10.1000/x.1'
		]);
		const pa = await database.db
			.select({ name: authors.name, orcid: authors.orcid, position: paperAuthors.position })
			.from(paperAuthors)
			.innerJoin(authors, eq(authors.id, paperAuthors.authorId))
			.where(eq(paperAuthors.paperId, r.paperId))
			.orderBy(paperAuthors.position);
		expect(pa).toEqual([
			{ name: 'Rui Yang', orcid: '0009-0003-5839-1059', position: 0 },
			{ name: 'Ada Lovelace', orcid: null, position: 1 }
		]);
		const [row] = await database.db.select().from(papers).where(eq(papers.id, r.paperId));
		expect(row?.searchVector).toContain("'test'");
		expect(row?.firstSeenAt.toISOString()).toBe(now.toISOString());
	});

	it('gleiche arXiv-ID → ein Datensatz; neue Version aktualisiert den Titel', async () => {
		const a = await upsertPaper(
			database.db,
			makePaper({ ids: { arxivId: '2611.00001' }, title: 'v1' })
		);
		const b = await upsertPaper(
			database.db,
			makePaper({ ids: { arxivId: '2611.00001' }, title: 'v2', updatedAt: new Date('2026-11-01') })
		);
		expect(b.paperId).toBe(a.paperId);
		expect(b.created).toBe(false);
		expect(await count()).toBe(1);
		const [row] = await database.db.select().from(papers);
		expect(row?.title).toBe('v2');
		expect(row?.sourceUpdatedAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
	});

	it('gleiche DOI aus verschiedenen Quellen → ein Datensatz, Verlagsmetadaten gewinnen', async () => {
		await upsertPaper(
			database.db,
			makePaper({
				source: 'europepmc',
				ids: { doi: '10.1000/abc', europepmcId: 'MED/1', pmid: '1' },
				title: 'EPMC title',
				abstract: 'Unlicensed abstract',
				abstractLicenseOk: false,
				categories: []
			})
		);
		await upsertPaper(
			database.db,
			makePaper({
				source: 'crossref',
				ids: { doi: '10.1000/abc' },
				title: 'Crossref title',
				abstract: 'CC BY abstract',
				abstractLicenseOk: true,
				categories: [],
				publishedAt: new Date('2026-10-25T00:00:00Z')
			})
		);
		expect(await count()).toBe(1);
		const [row] = await database.db.select().from(papers);
		expect(row).toMatchObject({
			title: 'Crossref title',
			metadataSource: 'crossref',
			abstract: 'CC BY abstract',
			abstractLicenseOk: true,
			abstractSource: 'crossref',
			sources: ['europepmc', 'crossref']
		});
		// Früheres Datum bleibt.
		expect(row?.publishedAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
	});

	it('führt arXiv-Preprint und Verlagsversion zusammen, sobald die DOI bekannt wird', async () => {
		const userId = await createUser(database.db, 'a@example.org');
		const preprint = await upsertPaper(
			database.db,
			makePaper({ ids: { arxivId: '2610.11111' }, title: 'Preprint', categories: ['cs.LG'] })
		);
		const journal = await upsertPaper(
			database.db,
			makePaper({
				source: 'crossref',
				ids: { doi: '10.1000/journal.1' },
				title: 'Journal version',
				categories: [],
				authors: [],
				publishedAt: new Date('2026-12-01T00:00:00Z')
			})
		);
		expect(journal.paperId).not.toBe(preprint.paperId);
		await database.db.insert(matches).values([
			{ userId, paperId: preprint.paperId, score: 0.4, saved: true, subscriptionIds: [1] },
			{ userId, paperId: journal.paperId, score: 0.9, seen: true, subscriptionIds: [2] }
		]);

		// arXiv meldet später die DOI (z. B. im RSS-Feld arxiv:DOI).
		const linked = await upsertPaper(
			database.db,
			makePaper({ ids: { arxivId: '2610.11111', doi: '10.1000/journal.1' }, title: 'Preprint v2' })
		);
		expect(linked.paperId).toBe(preprint.paperId);
		expect(linked.mergedPaperIds).toEqual([journal.paperId]);
		expect(await count()).toBe(1);

		const [row] = await database.db.select().from(papers);
		expect(row?.title).toBe('Journal version');
		expect(row?.categories).toEqual(['cs.LG', 'cs.DL']);
		expect(row?.publishedAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
		expect(await findPaperIdBy(database.db, 'doi', '10.1000/journal.1')).toBe(preprint.paperId);
		expect(await findPaperIdBy(database.db, 'arxiv', '2610.11111')).toBe(preprint.paperId);

		const m = await database.db.select().from(matches);
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ paperId: preprint.paperId, saved: true, seen: true });
		expect(m[0]?.score).toBeCloseTo(0.9);
		expect(m[0]?.subscriptionIds.sort()).toEqual([1, 2]);
		// Autoren aus dem Preprint bleiben, da die Verlagsversion keine hatte.
		const pa = await database.db.select().from(paperAuthors);
		expect(pa).toHaveLength(1);
	});

	it('echte Fixtures: arXiv (Maldacena) + Crossref-DOI ergeben einen Datensatz', async () => {
		const arxiv = parseArxivAtom(fixture('arxiv/idlist-mixed.atom.xml')).papers;
		for (const p of arxiv) await upsertPaper(database.db, p, now);
		const crossrefWork = (
			JSON.parse(fixture('crossref/work-maldacena-1998.json')) as {
				message: CrossrefWork;
			}
		).message;
		const cr = normalizeCrossrefWork(crossrefWork, now);
		if (!cr) throw new Error('fixture');
		const r = await upsertPaper(database.db, cr, now);
		expect(r.created).toBe(false);
		expect(await count()).toBe(3);
		const [row] = await database.db.select().from(papers).where(eq(papers.id, r.paperId));
		expect(row?.sources).toEqual(['arxiv', 'crossref']);
		expect(row?.metadataSource).toBe('crossref');
		expect(row?.title).toBe('The Large-N Limit of Superconformal Field Theories and Supergravity');
		// arXiv-Abstract (CC0) bleibt, Crossref liefert keinen.
		expect(row?.abstractSource).toBe('arxiv');
		expect(row?.publishedAt.toISOString()).toBe('1997-11-27T23:53:13.000Z');
	});

	it('Autor:innen werden über ORCID und normalisierten Namen dedupliziert', async () => {
		await upsertPaper(
			database.db,
			makePaper({
				authors: [{ name: 'Rui Yang', orcid: '0009-0003-5839-1059' }, { name: 'Jörg Müller' }]
			})
		);
		await upsertPaper(
			database.db,
			makePaper({
				authors: [{ name: 'R. Yang', orcid: '0009-0003-5839-1059' }, { name: 'Jörg  Müller' }]
			})
		);
		const rows = await database.db.select().from(authors).orderBy(authors.id);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.name).toBe('R. Yang');
		expect(rows[1]?.nameNormalized).toBe('jorg muller');
	});

	it('parallele Ingestion desselben Papers erzeugt keine Dubletten', async () => {
		const p = makePaper({ ids: { arxivId: '2611.22222', doi: '10.1000/race' } });
		const results = await Promise.all(Array.from({ length: 6 }, () => upsertPaper(database.db, p)));
		expect(new Set(results.map((r) => r.paperId)).size).toBe(1);
		expect(results.filter((r) => r.created)).toHaveLength(1);
		expect(await count()).toBe(1);
	});

	it('Umlaute, Sonderzeichen, LaTeX und sehr lange Abstracts', async () => {
		const longAbstract = 'Graph neural networks über Größen & „Anführungszeichen“. '.repeat(3000);
		const r = await upsertPaper(
			database.db,
			makePaper({
				title: 'Moduli spaces on $\\mathbb P^3$ – Überblick',
				abstract: longAbstract,
				authors: [{ name: "Mou'th Hourani" }, { name: 'Søren Kierkegaard' }]
			})
		);
		const [row] = await database.db.select().from(papers).where(eq(papers.id, r.paperId));
		expect(row?.title).toBe('Moduli spaces on $\\mathbb P^3$ – Überblick');
		expect(row?.abstract?.length).toBe(longAbstract.length);
	});

	it('EPMC-Fixture mit Markup und Umlauten lässt sich speichern', async () => {
		const { papers: list } = parseEuropePmcSearch(fixture('europepmc/umlaut-author-core.json'));
		for (const p of list) await upsertPaper(database.db, p, now);
		expect(await count()).toBe(list.length);
	});

	it('Volltext: Titeltreffer rangieren vor Abstract-Treffern', async () => {
		const titleHit = await upsertPaper(
			database.db,
			makePaper({ title: 'Graph neural networks for citations', abstract: 'We study things.' })
		);
		const abstractHit = await upsertPaper(
			database.db,
			makePaper({ title: 'Something else', abstract: 'We apply graph neural networks.' })
		);
		await upsertPaper(database.db, makePaper({ title: 'Unrelated', abstract: 'Nothing here.' }));
		const result = await database.db.execute<{ id: number; rank: number }>(sql`
			SELECT id, ts_rank_cd(search_vector, q) AS rank
			FROM papers, websearch_to_tsquery('english', 'graph neural network') q
			WHERE search_vector @@ q ORDER BY rank DESC`);
		expect(result.rows.map((r) => Number(r.id))).toEqual([titleHit.paperId, abstractHit.paperId]);
	});

	it('verweigert Paper ohne Identifikator', async () => {
		await expect(upsertPaper(database.db, makePaper({ ids: {} }))).rejects.toThrow(/Identifikator/);
	});
});
