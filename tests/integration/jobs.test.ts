import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import { createSubscription } from '$lib/server/db/queries';
import {
	authors,
	fetchLog,
	matches,
	papers,
	sourceQueries,
	sourceQueryStatus
} from '$lib/server/db/schema';
import {
	backfillSourceQuery,
	cleanup,
	enrichWithCrossref,
	ingestArxivDaily,
	ingestSourceQueries
} from '$lib/server/jobs/ingest';
import { parseArxivRss } from '$lib/server/sources/arxiv';
import { SourceHttpError, SourceRateLimitedError } from '$lib/server/sources/errors';
import { parseEuropePmcSearch } from '$lib/server/sources/europepmc';
import { fixture } from '../unit/sources/helpers';
import {
	closeTestDatabase,
	createUser,
	fakeSources,
	hasTestDb,
	jobContext,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

const NOW = new Date('2026-11-03T06:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!hasTestDb)('Jobs', () => {
	let database: Database;
	let userA: string;
	let userB: string;
	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		userA = await createUser(database.db, 'a@example.org');
		userB = await createUser(database.db, 'b@example.org');
	});
	afterAll(closeTestDatabase);

	const paperCount = async () =>
		(await database.db.select({ n: sql<number>`count(*)::int` }).from(papers))[0]?.n;
	const logs = () => database.db.select().from(fetchLog).orderBy(fetchLog.id);

	describe('Abo-Deduplizierung', () => {
		it('fasst gleiche Anfragen mehrerer Nutzer:innen zu einem source_query zusammen', async () => {
			const a = await createSubscription(database.db, {
				userId: userA,
				type: 'keyword',
				query: 'Graph  Neural Networks'
			});
			const b = await createSubscription(database.db, {
				userId: userB,
				type: 'keyword',
				query: 'graph neural networks'
			});
			expect(a.sourceQueryCreated).toBe(true);
			expect(b.sourceQueryCreated).toBe(false);
			expect(b.sourceQueryId).toBe(a.sourceQueryId);
			expect(await database.db.select().from(sourceQueries)).toHaveLength(1);
			// Erneutes Abo derselben Person ist idempotent.
			const again = await createSubscription(database.db, {
				userId: userA,
				type: 'keyword',
				query: 'graph neural networks',
				weight: 2
			});
			expect(again.subscriptionId).toBe(a.subscriptionId);
		});
	});

	describe('ingestArxivDaily', () => {
		it('lädt RSS für alle abonnierten Kategorien in einem gebündelten Aufruf', async () => {
			await createSubscription(database.db, { userId: userA, type: 'category', query: 'cs.DL' });
			await createSubscription(database.db, { userId: userB, type: 'category', query: 'cs.DL' });
			await createSubscription(database.db, { userId: userB, type: 'category', query: 'math.AG' });
			const { arxiv, sources } = fakeSources();
			arxiv.rss = parseArxivRss(fixture('arxiv/rss-cs-dl.rss.xml')).filter(
				(i) => i.announceType === 'new' || i.announceType === 'cross'
			);
			const ctx = jobContext(database.db, sources, NOW);

			const result = await ingestArxivDaily(ctx);
			expect(arxiv.rssCalls).toEqual([['cs.DL', 'math.AG']]);
			expect(result.newPaperIds).toHaveLength(10);
			expect(await paperCount()).toBe(10);
			const [log] = await logs();
			expect(log).toMatchObject({
				source: 'arxiv',
				kind: 'rss',
				status: 'ok',
				itemCount: 10,
				newPaperCount: 10
			});

			// Zweiter Lauf mit denselben Einträgen: keine neuen Paper.
			const again = await ingestArxivDaily(ctx);
			expect(again.newPaperIds).toHaveLength(0);
			expect(await paperCount()).toBe(10);
		});

		it('ohne Kategorie-Abos: kein Upstream-Aufruf, Protokoll „skipped“', async () => {
			const { arxiv, sources } = fakeSources();
			await ingestArxivDaily(jobContext(database.db, sources, NOW));
			expect(arxiv.rssCalls).toEqual([]);
			expect((await logs())[0]?.status).toBe('skipped');
		});

		it('Fehler werden protokolliert statt zu werfen', async () => {
			await createSubscription(database.db, { userId: userA, type: 'category', query: 'cs.DL' });
			const { arxiv, sources } = fakeSources();
			arxiv.rssError = new SourceHttpError('arxiv', 503, 'https://rss.arxiv.org/rss/cs.DL');
			const result = await ingestArxivDaily(jobContext(database.db, sources, NOW));
			expect(result.errors).toHaveLength(1);
			expect((await logs())[0]).toMatchObject({ status: 'error', source: 'arxiv' });
			const [status] = await database.db.select().from(sourceQueryStatus);
			expect(status?.lastError).toMatch(/503/);
			expect(status?.lastSuccessAt).toBeNull();
		});
	});

	describe('ingestSourceQueries', () => {
		it('Ausfall einer Quelle stoppt die andere nicht', async () => {
			const sub = await createSubscription(database.db, {
				userId: userA,
				type: 'keyword',
				query: 'malaria'
			});
			const { arxiv, europepmc, sources } = fakeSources();
			arxiv.error = new SourceHttpError('arxiv', 500, 'https://export.arxiv.org/api/query');
			europepmc.result = parseEuropePmcSearch(
				fixture('europepmc/search-preprints-core.json')
			).papers;

			const result = await ingestSourceQueries(jobContext(database.db, sources, NOW));
			expect(result.newPaperIds).toHaveLength(5);
			expect(result.errors).toEqual([
				expect.objectContaining({ source: 'arxiv', sourceQueryId: sub.sourceQueryId })
			]);
			const statuses = await database.db
				.select()
				.from(sourceQueryStatus)
				.orderBy(sourceQueryStatus.source);
			const bySource = Object.fromEntries(statuses.map((s) => [s.source, s]));
			expect(bySource.europepmc?.coveredUntil?.toISOString()).toBe(NOW.toISOString());
			expect(bySource.europepmc?.lastError).toBeNull();
			expect(bySource.arxiv?.lastError).toMatch(/HTTP 500/);
			expect(bySource.arxiv?.coveredUntil).toBeNull();
			expect((await logs()).map((l) => `${l.source}:${l.status}`).sort()).toEqual([
				'arxiv:error',
				'europepmc:ok'
			]);
		});

		it('Zeitfenster: Standard 1 Tag, danach ab coveredUntil mit 2 Tagen Überlappung, max. 30 Tage', async () => {
			await createSubscription(database.db, { userId: userA, type: 'author', query: 'Rui Yang' });
			const { arxiv, europepmc, sources } = fakeSources();
			const ctx = jobContext(database.db, sources, NOW);

			await ingestSourceQueries(ctx);
			expect(europepmc.searches[0]?.since.toISOString()).toBe(
				new Date(NOW.getTime() - DAY).toISOString()
			);
			expect(europepmc.searches[0]?.query).toEqual({ kind: 'author', value: 'rui yang' });
			expect(arxiv.searches).toHaveLength(1);

			ctx.clock.now = new Date(NOW.getTime() + DAY);
			await ingestSourceQueries(ctx);
			expect(europepmc.searches[1]?.since.toISOString()).toBe(
				new Date(NOW.getTime() - 2 * DAY).toISOString()
			);

			// Nach langem Ausfall wird auf 30 Tage begrenzt.
			ctx.clock.now = new Date(NOW.getTime() + 90 * DAY);
			await ingestSourceQueries(ctx);
			expect(europepmc.searches[2]?.since.toISOString()).toBe(
				new Date(NOW.getTime() + 60 * DAY).toISOString()
			);
		});

		it('Kategorie-Abos laufen nicht über die arXiv-Suche (dafür gibt es RSS)', async () => {
			await createSubscription(database.db, { userId: userA, type: 'category', query: 'cs.DL' });
			const { arxiv, europepmc, sources } = fakeSources();
			await ingestSourceQueries(jobContext(database.db, sources, NOW));
			expect(arxiv.searches).toHaveLength(0);
			expect(europepmc.searches).toHaveLength(0);
		});

		it('bricht eine Quelle bei Rate-Limit-Sperre ab, statt weiter anzufragen', async () => {
			for (const q of ['alpha', 'beta', 'gamma']) {
				await createSubscription(database.db, { userId: userA, type: 'keyword', query: q });
			}
			const { arxiv, europepmc, sources } = fakeSources();
			arxiv.error = new SourceRateLimitedError('arxiv', 3_600_000);
			await ingestSourceQueries(jobContext(database.db, sources, NOW));
			expect(arxiv.searches).toHaveLength(1);
			expect(europepmc.searches).toHaveLength(3);
		});

		it('Queries ohne Abo werden ignoriert', async () => {
			await database.db.insert(sourceQueries).values({ type: 'keyword', query: 'orphan' });
			const { arxiv, europepmc, sources } = fakeSources();
			await ingestSourceQueries(jobContext(database.db, sources, NOW));
			expect(arxiv.searches).toHaveLength(0);
			expect(europepmc.searches).toHaveLength(0);
		});
	});

	describe('backfillSourceQuery', () => {
		it('holt die letzten 30 Tage aus allen passenden Quellen, Kategorie via arXiv-API', async () => {
			const sub = await createSubscription(database.db, {
				userId: userA,
				type: 'category',
				query: 'cs.DL'
			});
			const { arxiv, europepmc, sources } = fakeSources();
			arxiv.result = [makePaper(), makePaper()];
			const result = await backfillSourceQuery(
				jobContext(database.db, sources, NOW),
				sub.sourceQueryId
			);
			expect(result.status).toBe('done');
			expect(result.newPaperIds).toHaveLength(2);
			expect(arxiv.searches[0]?.since.toISOString()).toBe(
				new Date(NOW.getTime() - 30 * DAY).toISOString()
			);
			expect(arxiv.searches[0]?.query).toEqual({ kind: 'category', value: 'cs.DL' });
			expect(europepmc.searches).toHaveLength(0);
			const [sq] = await database.db
				.select()
				.from(sourceQueries)
				.where(eq(sourceQueries.id, sub.sourceQueryId));
			expect(sq).toMatchObject({ backfillStatus: 'done', backfillError: null });
			expect(sq?.backfillFinishedAt?.toISOString()).toBe(NOW.toISOString());
		});

		it('Teilausfall → done mit Fehlertext; Totalausfall → failed', async () => {
			const sub = await createSubscription(database.db, {
				userId: userA,
				type: 'keyword',
				query: 'crispr'
			});
			const { arxiv, europepmc, sources } = fakeSources();
			arxiv.error = new Error('arxiv down');
			const ctx = jobContext(database.db, sources, NOW);
			expect((await backfillSourceQuery(ctx, sub.sourceQueryId)).status).toBe('done');
			const [sq] = await database.db.select().from(sourceQueries);
			expect(sq?.backfillError).toMatch(/arxiv: arxiv down/);

			europepmc.error = new Error('epmc down');
			expect((await backfillSourceQuery(ctx, sub.sourceQueryId)).status).toBe('failed');
		});

		it('Tage sind auf 30 begrenzt; unbekannte Query → missing', async () => {
			const sub = await createSubscription(database.db, {
				userId: userA,
				type: 'keyword',
				query: 'x'
			});
			const { europepmc, sources } = fakeSources();
			const ctx = jobContext(database.db, sources, NOW);
			await backfillSourceQuery(ctx, sub.sourceQueryId, { days: 365 });
			expect(europepmc.searches[0]?.since.toISOString()).toBe(
				new Date(NOW.getTime() - 30 * DAY).toISOString()
			);
			expect((await backfillSourceQuery(ctx, 999_999)).status).toBe('missing');
		});
	});

	describe('enrichWithCrossref', () => {
		it('ergänzt neue DOIs genau einmal und führt Daten zusammen', async () => {
			const { crossref, sources } = fakeSources();
			const ctx = jobContext(database.db, sources, NOW);
			const stored = await upsertPaper(
				database.db,
				makePaper({ ids: { arxivId: '2610.20000', doi: '10.1000/enrich' }, abstract: undefined })
			);
			await upsertPaper(database.db, makePaper({ ids: { arxivId: '2610.20001' } }));
			crossref.result = [
				makePaper({
					source: 'crossref',
					ids: { doi: '10.1000/enrich' },
					title: 'Published title',
					abstract: 'Open abstract',
					abstractLicenseOk: true,
					journal: 'Journal of Tests',
					categories: []
				})
			];
			const first = await enrichWithCrossref(ctx);
			expect(first).toEqual({ checked: 1, found: 1 });
			expect(crossref.calls).toEqual([['10.1000/enrich']]);
			const [row] = await database.db.select().from(papers).where(eq(papers.id, stored.paperId));
			expect(row).toMatchObject({
				title: 'Published title',
				journal: 'Journal of Tests',
				abstract: 'Open abstract'
			});
			expect(row?.crossrefCheckedAt?.toISOString()).toBe(NOW.toISOString());

			const second = await enrichWithCrossref(ctx);
			expect(second.checked).toBe(0);
			expect(crossref.calls).toHaveLength(1);
		});

		it('bei Fehler bleibt das Paper ungeprüft und der Fehler protokolliert', async () => {
			const { crossref, sources } = fakeSources();
			crossref.error = new Error('crossref down');
			await upsertPaper(database.db, makePaper({ ids: { doi: '10.1000/fail' } }));
			const result = await enrichWithCrossref(jobContext(database.db, sources, NOW));
			expect(result.error).toBe('crossref down');
			const [row] = await database.db.select().from(papers);
			expect(row?.crossrefCheckedAt).toBeNull();
			expect((await logs())[0]).toMatchObject({ source: 'crossref', status: 'error' });
		});
	});

	describe('cleanup', () => {
		it('löscht nur alte Paper ohne Treffer sowie Verwaistes', async () => {
			const old = new Date(NOW.getTime() - 200 * DAY);
			const oldUnmatched = await upsertPaper(
				database.db,
				makePaper({ publishedAt: old, authors: [{ name: 'Only Here' }] }),
				old
			);
			const oldMatched = await upsertPaper(database.db, makePaper({ publishedAt: old }), old);
			const recent = await upsertPaper(database.db, makePaper(), NOW);
			// Alt veröffentlicht, aber erst kürzlich erfasst → bleibt (noch).
			const oldButNew = await upsertPaper(database.db, makePaper({ publishedAt: old }), NOW);
			await database.db
				.insert(matches)
				.values({ userId: userA, paperId: oldMatched.paperId, score: 1 });
			await database.db
				.insert(sourceQueries)
				.values({ type: 'keyword', query: 'orphan', createdAt: old });
			await database.db.insert(fetchLog).values({
				source: 'arxiv',
				kind: 'rss',
				startedAt: old,
				finishedAt: old,
				status: 'ok'
			});

			const result = await cleanup(jobContext(database.db, fakeSources().sources, NOW));
			expect(result).toMatchObject({ papers: 1, sourceQueries: 1, fetchLog: 1 });
			expect(result.authors).toBeGreaterThanOrEqual(1);
			const remaining = (await database.db.select({ id: papers.id }).from(papers)).map((r) => r.id);
			expect(remaining.sort()).toEqual(
				[oldMatched.paperId, recent.paperId, oldButNew.paperId].sort()
			);
			expect(remaining).not.toContain(oldUnmatched.paperId);
			const names = (await database.db.select({ name: authors.name }).from(authors)).map(
				(a) => a.name
			);
			expect(names).not.toContain('Only Here');
		});
	});
});
