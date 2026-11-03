import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MatchReason } from '$lib/ranking/reasons';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import { createSubscription } from '$lib/server/db/queries';
import { matches, papers, subscriptions } from '$lib/server/db/schema';
import { silentLogger } from '$lib/server/log';
import { feedForUser } from '$lib/server/feed';
import { liveScoreSql, runMatching } from '$lib/server/ranking/match';
import type { NormalizedPaper } from '$lib/server/sources/types';
import {
	closeTestDatabase,
	createUser,
	hasTestDb,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

const NOW = new Date('2026-11-03T06:00:00Z');
const DAY = 86_400_000;

describe.skipIf(!hasTestDb)('Matching', () => {
	let database: Database;
	let alice: string;
	let bob: string;
	let clock: Date;
	const ctx = () => ({ db: database.db, logger: silentLogger, now: () => clock });

	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		await database.db.execute(sql`TRUNCATE job_state`);
		alice = await createUser(database.db, 'alice@example.org');
		bob = await createUser(database.db, 'bob@example.org');
		clock = NOW;
	});
	afterAll(closeTestDatabase);

	/** Paper „neu erfasst“ zu einem Zeitpunkt (first_seen_at). */
	const ingest = (p: Partial<NormalizedPaper>, seenAt = new Date(NOW.getTime() - 3600_000)) =>
		upsertPaper(database.db, makePaper(p), seenAt);
	const subscribe = (
		userId: string,
		type: 'keyword' | 'category' | 'author',
		query: string,
		weight = 1
	) => createSubscription(database.db, { userId, type, query, weight });
	const userMatches = (userId: string) =>
		database.db
			.select()
			.from(matches)
			.where(eq(matches.userId, userId))
			.orderBy(desc(matches.score));

	it('Stichwort: Titeltreffer vor Abstract-Treffer, Begründung gespeichert', async () => {
		const sub = await subscribe(alice, 'keyword', 'graph neural networks');
		// Erstes Matching erledigt die Initialphase für das neue Abo.
		await runMatching(ctx());
		clock = new Date(NOW.getTime() + DAY);
		const later = new Date(NOW.getTime() + 3600_000);
		const titleHit = await ingest(
			{ title: 'Graph neural networks for citation graphs', abstract: 'We study X.' },
			later
		);
		const abstractHit = await ingest(
			{ title: 'A study', abstract: 'We apply graph neural networks to Y.' },
			later
		);
		await ingest({ title: 'Unrelated', abstract: 'Nothing.' }, later);

		const result = await runMatching(ctx());
		expect(result.candidatePapers).toBe(3);
		const rows = await userMatches(alice);
		expect(rows.map((r) => r.paperId)).toEqual([titleHit.paperId, abstractHit.paperId]);
		const [first, second] = rows;
		expect((first?.reasons as MatchReason[])[0]).toMatchObject({
			subscriptionId: sub.subscriptionId,
			type: 'keyword',
			query: 'graph neural networks',
			inTitle: true
		});
		expect((second?.reasons as MatchReason[])[0]?.inTitle).toBe(false);
		expect(first?.subscriptionIds).toEqual([sub.subscriptionId]);
		expect(first?.relevance).toBeGreaterThan(0);
	});

	it('Kategorie, Autor:in per ORCID und per Name (auch abgekürzt, ohne Diakritika)', async () => {
		const c = await subscribe(alice, 'category', 'cs.DL');
		const o = await subscribe(alice, 'author', '0009-0003-5839-1059');
		const n = await subscribe(bob, 'author', 'Jörg Müller');
		await runMatching(ctx());
		clock = new Date(NOW.getTime() + DAY);
		const later = new Date(NOW.getTime() + 3600_000);

		const pCat = await ingest({ categories: ['cs.DL'], authors: [] }, later);
		const pOrcid = await ingest(
			{ categories: ['math.AG'], authors: [{ name: 'R. Yang', orcid: '0009-0003-5839-1059' }] },
			later
		);
		const pAbbrev = await ingest(
			{ categories: ['math.AG'], authors: [{ name: 'J. Muller' }] },
			later
		);
		const pFull = await ingest(
			{ categories: ['math.AG'], authors: [{ name: 'Jorg Müller' }] },
			later
		);
		await ingest({ categories: ['math.AG'], authors: [{ name: 'Maria Müller' }] }, later);

		await runMatching(ctx());
		const a = await userMatches(alice);
		expect(new Set(a.map((m) => m.paperId))).toEqual(new Set([pCat.paperId, pOrcid.paperId]));
		expect(a.find((m) => m.paperId === pCat.paperId)?.subscriptionIds).toEqual([c.subscriptionId]);
		expect(a.find((m) => m.paperId === pOrcid.paperId)?.subscriptionIds).toEqual([
			o.subscriptionId
		]);
		const b = await userMatches(bob);
		expect(new Set(b.map((m) => m.paperId))).toEqual(new Set([pAbbrev.paperId, pFull.paperId]));
		expect(b[0]?.subscriptionIds).toEqual([n.subscriptionId]);
	});

	it('ein Paper erscheint pro Person nur einmal – mit allen getroffenen Abos', async () => {
		const k1 = await subscribe(alice, 'keyword', 'crispr');
		const k2 = await subscribe(alice, 'keyword', 'cas12a diagnostics');
		const c = await subscribe(alice, 'category', 'q-bio.GN');
		await subscribe(bob, 'keyword', 'CRISPR');
		await runMatching(ctx());
		clock = new Date(NOW.getTime() + DAY);
		const later = new Date(NOW.getTime() + 3600_000);
		const p = await ingest(
			{
				title: 'CRISPR-Cas12a diagnostics',
				abstract: 'Cas12a diagnostics with CRISPR reporters.',
				categories: ['q-bio.GN']
			},
			later
		);
		await runMatching(ctx());
		await runMatching(ctx()); // idempotent

		const a = await userMatches(alice);
		expect(a).toHaveLength(1);
		expect(a[0]?.paperId).toBe(p.paperId);
		expect(a[0]?.subscriptionIds).toEqual(
			[k1.subscriptionId, k2.subscriptionId, c.subscriptionId].sort((x, y) => x - y)
		);
		expect((a[0]?.reasons as MatchReason[]).map((r) => r.type).sort()).toEqual([
			'category',
			'keyword',
			'keyword'
		]);
		expect(await userMatches(bob)).toHaveLength(1);
		const total = await database.db.select({ n: sql<number>`count(*)::int` }).from(matches);
		expect(total[0]?.n).toBe(2);
	});

	it('Wasserstand: nur neue Paper; Gelesen/Gemerkt bleibt bei Neuberechnung erhalten', async () => {
		await subscribe(alice, 'keyword', 'quantum');
		const first = await ingest({ title: 'Quantum error correction' });
		const r1 = await runMatching(ctx());
		expect(r1.matchesWritten).toBe(1);

		await database.db
			.update(matches)
			.set({ seen: true, saved: true })
			.where(and(eq(matches.userId, alice), eq(matches.paperId, first.paperId)));

		clock = new Date(NOW.getTime() + DAY);
		const r2 = await runMatching(ctx());
		expect(r2).toMatchObject({ candidatePapers: 0, newSubscriptions: 0, matchesWritten: 0 });

		// Neues Abo derselben Person trifft das alte Paper erneut → Score neu, Flags bleiben.
		await subscribe(alice, 'category', 'cs.DL');
		const r3 = await runMatching(ctx());
		expect(r3.newSubscriptions).toBe(1);
		const [m] = await userMatches(alice);
		expect(m).toMatchObject({ seen: true, saved: true });
		expect(m?.subscriptionIds).toHaveLength(2);
	});

	it('Nachzügler: spät committete Ingestion mit älterem Zeitstempel wird nicht übersehen', async () => {
		await subscribe(alice, 'keyword', 'neutrino');
		await runMatching(ctx()); // Wasserstand = NOW
		// Ingestion begann 5 Minuten vor dem Lauf, wurde aber erst danach sichtbar.
		const late = await ingest({ title: 'Neutrino masses' }, new Date(NOW.getTime() - 5 * 60_000));
		clock = new Date(NOW.getTime() + DAY);
		await runMatching(ctx());
		expect((await userMatches(alice)).map((m) => m.paperId)).toEqual([late.paperId]);
	});

	it('neues Abo: vorhandene Paper der letzten 30 Tage, ältere nicht', async () => {
		const recent = await ingest(
			{ title: 'Topological insulators today', publishedAt: new Date(NOW.getTime() - 10 * DAY) },
			new Date(NOW.getTime() - 10 * DAY)
		);
		await ingest(
			{ title: 'Topological insulators long ago', publishedAt: new Date(NOW.getTime() - 60 * DAY) },
			new Date(NOW.getTime() - 60 * DAY)
		);
		await runMatching(ctx()); // keine Abos → nichts
		const sub = await subscribe(bob, 'keyword', 'topological insulators');
		const result = await runMatching(ctx());
		expect(result.newSubscriptions).toBe(1);
		const rows = await userMatches(bob);
		expect(rows.map((r) => r.paperId)).toEqual([recent.paperId]);
		const [row] = await database.db
			.select({ at: subscriptions.initialMatchedAt })
			.from(subscriptions)
			.where(eq(subscriptions.id, sub.subscriptionId));
		expect(row?.at?.toISOString()).toBe(NOW.toISOString());
	});

	it('leere Abstracts, Umlaute, Sonderzeichen und LaTeX', async () => {
		await subscribe(alice, 'keyword', 'Größenordnung');
		await subscribe(alice, 'keyword', '"naïve bayes"');
		await subscribe(alice, 'keyword', 'mathbb');
		const noAbstract = await ingest({ title: 'Größenordnung von Zitationen', abstract: undefined });
		const diacritics = await ingest({ title: 'A naïve Bayes baseline', abstract: '' });
		const latex = await ingest({
			title: 'Sheaves on $\\mathbb P^3$',
			abstract: 'Quot schemes & stuff <b>'
		});
		await subscribe(alice, 'keyword', 'the and of'); // nur Stoppwörter → kein Treffer, kein Fehler
		await runMatching(ctx());
		const ids = new Set((await userMatches(alice)).map((m) => m.paperId));
		expect(ids).toEqual(new Set([noAbstract.paperId, diacritics.paperId, latex.paperId]));
	});

	it('sehr lange Abstracts werden gespeichert und gefunden', async () => {
		// > 1 MB tsvector ohne Begrenzung (Postgres-Fehler „string is too long for tsvector“).
		const words = Array.from(
			{ length: 60_000 },
			(_, i) => `w${i.toString(36)}x${(i * 7919).toString(36)}`
		);
		const abstract = `Superconducting qubits are discussed. ${words.join(' ')}`;
		await subscribe(alice, 'keyword', 'superconducting qubits');
		const p = await ingest({ title: 'A long one', abstract });
		const [stored] = await database.db.select().from(papers).where(eq(papers.id, p.paperId));
		expect(stored?.abstract?.length).toBe(abstract.length);
		await runMatching(ctx());
		expect((await userMatches(alice)).map((m) => m.paperId)).toEqual([p.paperId]);
	});

	it('Duplikate aus verschiedenen Quellen ergeben einen Treffer', async () => {
		await subscribe(alice, 'keyword', 'protein folding');
		await ingest({ ids: { arxivId: '2610.33333' }, title: 'Protein folding with diffusion' });
		await ingest({
			source: 'crossref',
			ids: { arxivId: '2610.33333', doi: '10.1000/fold' },
			title: 'Protein folding with diffusion models'
		});
		await runMatching(ctx());
		expect(await userMatches(alice)).toHaveLength(1);
	});

	it('Live-Score: bei gleicher Relevanz zuerst das neuere Paper', async () => {
		await subscribe(alice, 'category', 'cs.DL');
		const older = await ingest({
			categories: ['cs.DL'],
			publishedAt: new Date(NOW.getTime() - 14 * DAY)
		});
		const newer = await ingest({
			categories: ['cs.DL'],
			publishedAt: new Date(NOW.getTime() - 1 * DAY)
		});
		await runMatching(ctx());
		const later = new Date(NOW.getTime() + 30 * DAY);
		const rows = await database.db
			.select({ paperId: matches.paperId, live: liveScoreSql(7, later) })
			.from(matches)
			.innerJoin(papers, eq(papers.id, matches.paperId))
			.where(eq(matches.userId, alice))
			.orderBy(desc(liveScoreSql(7, later)));
		expect(rows.map((r) => r.paperId)).toEqual([newer.paperId, older.paperId]);
		expect(Number(rows[0]?.live)).toBeGreaterThan(Number(rows[1]?.live));
		expect(Number(rows[0]?.live)).toBeLessThan(0.3 * 0.5 ** (30 / 7));
	});

	it('Feed: Live-Sortierung, ausgeblendete fehlen, Abstract nur bei Lizenz, Autoren gekürzt', async () => {
		await subscribe(alice, 'keyword', 'dark matter', 2);
		await subscribe(alice, 'category', 'astro-ph.CO');
		const strong = await ingest({
			title: 'Dark matter halos',
			abstract: 'Open abstract about dark matter.',
			abstractLicenseOk: true,
			categories: ['astro-ph.CO'],
			authors: Array.from({ length: 8 }, (_, i) => ({ name: `Author ${i}` }))
		});
		const weak = await ingest({
			title: 'Cosmology survey',
			abstract: 'Closed abstract.',
			abstractLicenseOk: false,
			categories: ['astro-ph.CO']
		});
		const hidden = await ingest({ title: 'Dark matter again', categories: [] });
		await runMatching(ctx());
		await database.db
			.update(matches)
			.set({ hidden: true })
			.where(and(eq(matches.userId, alice), eq(matches.paperId, hidden.paperId)));

		const feed = await feedForUser(database.db, alice, {
			now: NOW,
			halfLifeDays: 7,
			maxAuthors: 3
		});
		expect(feed.map((f) => f.paperId)).toEqual([strong.paperId, weak.paperId]);
		expect(feed[0]).toMatchObject({
			abstract: 'Open abstract about dark matter.',
			authors: ['Author 0', 'Author 1', 'Author 2'],
			authorCount: 8
		});
		expect(feed[0]?.reasons.map((r) => r.type)).toEqual(['keyword', 'category']);
		expect(feed[1]?.abstract).toBeNull();
		expect(feed[0]?.score).toBeGreaterThan(feed[1]?.score ?? 0);
		expect(await feedForUser(database.db, bob, { now: NOW, halfLifeDays: 7 })).toEqual([]);
	});
});
