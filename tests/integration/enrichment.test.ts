import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import { authors, fetchLog, matches, openalexUsage, papers } from '$lib/server/db/schema';
import {
	DEFAULT_OPENALEX_BUDGET,
	OpenAlexUsageTracker,
	type OpenAlexBudgetConfig
} from '$lib/server/enrichment/budget';
import { enrichWithOpenAlex, selectCandidates } from '$lib/server/enrichment/openalex';
import { silentLogger } from '$lib/server/log';
import { feedPage } from '$lib/server/papers-view';
import { SourceBudgetExhaustedError, SourceHttpError } from '$lib/server/sources/errors';
import type { IdRef, NormalizedPaper } from '$lib/server/sources/types';
import {
	closeTestDatabase,
	createUser,
	hasTestDb,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

const NOW = new Date('2026-11-08T03:13:00Z'); // Sonntag, 04:13 in Berlin
const DAY = 86_400_000;

/** OpenAlex-Attrappe: meldet Verbrauch über denselben Hook wie der echte HttpClient. */
class FakeOpenAlex {
	enabled = true;
	calls: IdRef[] = [];
	creditsPerCall = 0;
	remaining: number | undefined = 9999;
	results = new Map<string, NormalizedPaper>();
	errors = new Map<string, Error>();
	constructor(private readonly tracker: OpenAlexUsageTracker) {}

	async getById(ref: IdRef): Promise<NormalizedPaper[]> {
		this.calls.push(ref);
		const key = `${ref.type}:${ref.value}`;
		const error = this.errors.get(key);
		this.tracker.record({
			creditsUsed: error ? 0 : this.creditsPerCall,
			...(this.remaining !== undefined ? { remaining: this.remaining } : {}),
			status: error ? 429 : 200
		});
		if (error) throw error;
		const hit = this.results.get(key);
		return hit ? [hit] : [];
	}
}

describe.skipIf(!hasTestDb)('OpenAlex-Anreicherung', () => {
	let database: Database;
	let alice: string;
	let tracker: OpenAlexUsageTracker;
	let openalex: FakeOpenAlex;
	let clock: Date;

	const ctx = (budget: Partial<OpenAlexBudgetConfig> = {}) => ({
		db: database.db,
		logger: silentLogger,
		now: () => clock,
		openalex,
		tracker,
		budget: { ...DEFAULT_OPENALEX_BUDGET, ...budget }
	});

	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		await database.db.execute(sql`TRUNCATE openalex_usage`);
		alice = await createUser(database.db, 'alice@example.org');
		clock = NOW;
		tracker = new OpenAlexUsageTracker(() => clock);
		openalex = new FakeOpenAlex(tracker);
	});
	afterAll(closeTestDatabase);

	/** Paper mit Treffer für Alice anlegen. */
	async function paperWithMatch(
		ids: NormalizedPaper['ids'],
		match: { relevance: number; saved?: boolean; daysAgo?: number },
		overrides: Partial<NormalizedPaper> = {}
	) {
		const p = await upsertPaper(database.db, makePaper({ ids, ...overrides }), NOW);
		await database.db.insert(matches).values({
			userId: alice,
			paperId: p.paperId,
			score: match.relevance,
			relevance: match.relevance,
			saved: match.saved ?? false,
			reasons: [
				{ subscriptionId: 1, type: 'keyword', query: 'x', weight: 1, contribution: match.relevance }
			],
			createdAt: new Date(NOW.getTime() - (match.daysAgo ?? 1) * DAY)
		});
		return p.paperId;
	}

	const openalexWork = (
		doi: string,
		cited: number,
		extra: Partial<NormalizedPaper> = {}
	): NormalizedPaper => ({
		source: 'openalex',
		ids: { openalexId: `W${Math.abs(hash(doi))}`, doi },
		title: 'OpenAlex title (niedrigste Priorität)',
		abstractLicenseOk: false,
		authors: [],
		categories: [],
		publishedAt: new Date('2026-11-01T00:00:00Z'),
		updatedAt: NOW,
		landingUrl: `https://doi.org/${doi}`,
		citedByCount: cited,
		...extra
	});
	const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

	it('ohne API-Key: sauber übersprungen, kein Request', async () => {
		openalex.enabled = false;
		await paperWithMatch({ doi: '10.1000/a' }, { relevance: 1 });
		const result = await enrichWithOpenAlex(ctx());
		expect(result.status).toBe('disabled');
		expect(openalex.calls).toEqual([]);
		const [log] = await database.db.select().from(fetchLog);
		expect(log).toMatchObject({ source: 'openalex', kind: 'enrich', status: 'skipped' });
	});

	it('Kandidaten: gemerkte zuerst, dann gut gerankte; Rest ausgeschlossen; ID-Vorrang', async () => {
		const lowSaved = await paperWithMatch(
			{ doi: '10.1000/saved' },
			{ relevance: 0.05, saved: true }
		);
		const high = await paperWithMatch(
			{ doi: '10.1000/high', openalexId: 'W42' },
			{ relevance: 0.9 }
		);
		const mid = await paperWithMatch({ pmid: '777', europepmcId: 'MED/777' }, { relevance: 0.5 });
		await paperWithMatch({ doi: '10.1000/low' }, { relevance: 0.1 }); // nicht gut gerankt
		await paperWithMatch({ doi: '10.1000/old' }, { relevance: 0.9, daysAgo: 45 }); // zu alt
		await paperWithMatch({ arxivId: '2611.99999' }, { relevance: 0.9 }); // keine passende ID
		const recent = await paperWithMatch({ doi: '10.1000/recent' }, { relevance: 0.9 });
		await database.db
			.update(papers)
			.set({ openalexCheckedAt: new Date(NOW.getTime() - 2 * DAY) })
			.where(eq(papers.id, recent));

		const candidates = await selectCandidates(database.db, NOW, DEFAULT_OPENALEX_BUDGET, 100);
		expect(candidates).toEqual([
			{ paperId: lowSaved, ref: { type: 'doi', value: '10.1000/saved' } },
			{ paperId: high, ref: { type: 'openalex', value: 'W42' } },
			{ paperId: mid, ref: { type: 'pmid', value: '777' } }
		]);
	});

	it('übernimmt Zitationszahlen, verknüpft Autoren-IDs, markiert auch nicht gefundene', async () => {
		const found = await paperWithMatch(
			{ doi: '10.1000/found' },
			{ relevance: 0.9 },
			{ title: 'Original title', authors: [{ name: 'Rui Yang', orcid: '0009-0003-5839-1059' }] }
		);
		const missing = await paperWithMatch({ doi: '10.1000/missing' }, { relevance: 0.8 });
		openalex.results.set(
			'doi:10.1000/found',
			openalexWork('10.1000/found', 321, {
				authors: [{ name: 'Rui Yang', orcid: '0009-0003-5839-1059', openalexId: 'A123' }]
			})
		);

		const result = await enrichWithOpenAlex(ctx());
		expect(result).toMatchObject({
			status: 'done',
			checked: 2,
			updated: 1,
			notFound: 1,
			failed: 0
		});
		const [p] = await database.db.select().from(papers).where(eq(papers.id, found));
		expect(p).toMatchObject({ citedByCount: 321, title: 'Original title' });
		expect(p?.sources).toContain('openalex');
		expect(p?.citedByUpdatedAt?.toISOString()).toBe(NOW.toISOString());
		const [m] = await database.db.select().from(papers).where(eq(papers.id, missing));
		expect(m?.openalexCheckedAt?.toISOString()).toBe(NOW.toISOString());
		expect(m?.citedByCount).toBeNull();
		const [a] = await database.db
			.select()
			.from(authors)
			.where(eq(authors.orcid, '0009-0003-5839-1059'));
		expect(a?.openalexId).toBe('A123');

		// Verbrauch protokolliert
		const [usage] = await database.db.select().from(openalexUsage);
		expect(usage).toMatchObject({
			day: '2026-11-08',
			requests: 2,
			credits: 0,
			lastRemaining: 9999
		});
		// Zweiter Lauf in derselben Woche: nichts mehr zu tun
		expect((await enrichWithOpenAlex(ctx())).checked).toBe(0);
	});

	it('Request-Budget erreicht: pausiert sauber und setzt nach Mitternacht UTC fort', async () => {
		for (let i = 0; i < 3; i++)
			await paperWithMatch({ doi: `10.1000/b${i}` }, { relevance: 0.9 - i * 0.1 });
		const first = await enrichWithOpenAlex(ctx({ dailyRequests: 2 }));
		expect(first).toMatchObject({ status: 'paused', reason: 'requests', checked: 2, remaining: 1 });
		expect(first.resumeAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
		expect(openalex.calls).toHaveLength(2);

		// Gleicher Tag: weiterhin pausiert, ohne Request
		const again = await enrichWithOpenAlex(ctx({ dailyRequests: 2 }));
		expect(again).toMatchObject({ status: 'paused', checked: 0 });
		expect(openalex.calls).toHaveLength(2);

		// Nach dem Reset: nur der verbleibende Kandidat
		clock = new Date('2026-11-09T00:05:00Z');
		const resumed = await enrichWithOpenAlex(ctx({ dailyRequests: 2 }));
		expect(resumed).toMatchObject({ status: 'done', checked: 1, remaining: 0 });
		expect(openalex.calls.map((c) => c.value)).toEqual(['10.1000/b0', '10.1000/b1', '10.1000/b2']);
		const usage = await database.db.select().from(openalexUsage).orderBy(openalexUsage.day);
		expect(usage.map((u) => [u.day, u.requests])).toEqual([
			['2026-11-08', 2],
			['2026-11-09', 1]
		]);
	});

	it('Credit-Budget und gemeldetes Restbudget', async () => {
		for (let i = 0; i < 4; i++) await paperWithMatch({ doi: `10.1000/c${i}` }, { relevance: 0.9 });
		openalex.creditsPerCall = 5;
		expect(await enrichWithOpenAlex(ctx({ dailyCredits: 10 }))).toMatchObject({
			status: 'paused',
			reason: 'credits',
			checked: 2
		});

		clock = new Date(NOW.getTime() + DAY);
		openalex.creditsPerCall = 0;
		openalex.remaining = 10;
		expect(await enrichWithOpenAlex(ctx({ minRemaining: 50 }))).toMatchObject({
			status: 'paused',
			reason: 'remaining',
			checked: 1
		});
	});

	it('leeres Budget beim Server: pausieren statt Fehler werfen; andere Fehler überspringen', async () => {
		await paperWithMatch({ doi: '10.1000/e0' }, { relevance: 0.9 });
		const failing = await paperWithMatch({ doi: '10.1000/e1' }, { relevance: 0.8 });
		await paperWithMatch({ doi: '10.1000/e2' }, { relevance: 0.7 });
		openalex.errors.set(
			'doi:10.1000/e1',
			new SourceHttpError('openalex', 500, 'https://api.openalex.org/works/doi:10.1000/e1')
		);
		openalex.errors.set(
			'doi:10.1000/e2',
			new SourceBudgetExhaustedError('openalex', 'Tagesbudget an Credits aufgebraucht')
		);

		const result = await enrichWithOpenAlex(ctx());
		expect(result).toMatchObject({
			status: 'paused',
			reason: 'server',
			checked: 1,
			failed: 1,
			remaining: 1
		});
		const [p] = await database.db.select().from(papers).where(eq(papers.id, failing));
		expect(p?.openalexCheckedAt).toBeNull(); // wird beim nächsten Lauf erneut versucht
		const [log] = await database.db.select().from(fetchLog);
		expect(log).toMatchObject({ source: 'openalex', status: 'ok' });
		expect((log?.detail as { status: string }).status).toBe('paused');
	});

	it('Feed-Sortierung „Häufig zitiert“', async () => {
		const few = await paperWithMatch({ doi: '10.1000/few' }, { relevance: 0.9 });
		const many = await paperWithMatch({ doi: '10.1000/many' }, { relevance: 0.2 });
		const unknown = await paperWithMatch({ doi: '10.1000/unknown' }, { relevance: 0.95 });
		await database.db.update(papers).set({ citedByCount: 3 }).where(eq(papers.id, few));
		await database.db.update(papers).set({ citedByCount: 500 }).where(eq(papers.id, many));
		const byCitations = await feedPage(database.db, alice, {
			now: NOW,
			halfLifeDays: 7,
			sort: 'zitiert'
		});
		expect(byCitations.items.map((c) => c.paperId)).toEqual([many, few, unknown]);
		expect(byCitations.items[0]?.citedByCount).toBe(500);
		const byRelevance = await feedPage(database.db, alice, { now: NOW, halfLifeDays: 7 });
		expect(byRelevance.items.map((c) => c.paperId)).toEqual([unknown, few, many]);
	});
});
