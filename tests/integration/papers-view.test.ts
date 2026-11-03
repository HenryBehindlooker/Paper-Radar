import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import { createSubscription } from '$lib/server/db/queries';
import { matches } from '$lib/server/db/schema';
import { silentLogger } from '$lib/server/log';
import {
	feedPage,
	paperDetail,
	savedPapers,
	searchPage,
	setPaperState
} from '$lib/server/papers-view';
import { runMatching } from '$lib/server/ranking/match';
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

describe.skipIf(!hasTestDb)('Lesemodell: Feed, Suche, Merkliste, Detail', () => {
	let database: Database;
	let alice: string;
	let bob: string;
	const feed = (userId: string, opts: Partial<Parameters<typeof feedPage>[2]> = {}) =>
		feedPage(database.db, userId, { now: NOW, halfLifeDays: 7, ...opts });

	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		alice = await createUser(database.db, 'alice@example.org');
		bob = await createUser(database.db, 'bob@example.org');
	});
	afterAll(closeTestDatabase);

	async function seedFeed(n: number) {
		await createSubscription(database.db, { userId: alice, type: 'category', query: 'cs.DL' });
		const ids: number[] = [];
		for (let i = 0; i < n; i++) {
			const r = await upsertPaper(
				database.db,
				makePaper({
					title: `Digital library study ${i}`,
					categories: ['cs.DL'],
					publishedAt: new Date(NOW.getTime() - i * DAY)
				}),
				NOW
			);
			ids.push(r.paperId);
		}
		await runMatching({ db: database.db, logger: silentLogger, now: () => NOW });
		return ids;
	}

	it('Feed: neueste zuerst bei gleicher Relevanz, Seiten, Filter', async () => {
		const ids = await seedFeed(5);
		const p1 = await feed(alice, { size: 2 });
		expect(p1.items.map((c) => c.paperId)).toEqual([ids[0], ids[1]]);
		expect(p1.hasMore).toBe(true);
		const p3 = await feed(alice, { size: 2, page: 3 });
		expect(p3.items.map((c) => c.paperId)).toEqual([ids[4]]);
		expect(p3.hasMore).toBe(false);

		await setPaperState(database.db, alice, ids[0] as number, 'seen', true);
		await setPaperState(database.db, alice, ids[1] as number, 'hidden', true);
		const unread = await feed(alice, { filter: 'ungelesen' });
		expect(unread.items.map((c) => c.paperId)).toEqual([ids[2], ids[3], ids[4]]);
		const hidden = await feed(alice, { filter: 'ausgeblendet' });
		expect(hidden.items.map((c) => c.paperId)).toEqual([ids[1]]);
		const all = await feed(alice);
		expect(all.items).toHaveLength(4);
		expect(all.items[0]).toMatchObject({ seen: true, saved: false, hidden: false });
		expect(all.items[0]?.reasons[0]?.type).toBe('category');
		expect(all.items[0]?.ids.arxivId).toBeTruthy();
	});

	it('Merken aus der Suche: erscheint in der Merkliste, aber nicht im Feed', async () => {
		const p = await upsertPaper(database.db, makePaper({ title: 'Quantum gravity notes' }), NOW);
		const result = await searchPage(database.db, alice, 'quantum gravity');
		expect(result.items.map((c) => c.paperId)).toEqual([p.paperId]);
		expect(result.items[0]?.saved).toBe(false);

		expect(await setPaperState(database.db, alice, p.paperId, 'saved', true)).toBe(true);
		expect((await savedPapers(database.db, alice)).items.map((c) => c.paperId)).toEqual([
			p.paperId
		]);
		expect((await feed(alice)).items).toEqual([]);
		expect((await searchPage(database.db, alice, 'quantum gravity')).items[0]?.saved).toBe(true);
		// Bob sieht Alices Status nicht.
		expect((await searchPage(database.db, bob, 'quantum gravity')).items[0]?.saved).toBe(false);

		await setPaperState(database.db, alice, p.paperId, 'saved', false);
		expect((await savedPapers(database.db, alice)).items).toEqual([]);
		expect(await setPaperState(database.db, alice, 999_999, 'saved', true)).toBe(false);
	});

	it('Merkliste: zuletzt gemerkt zuerst; Merken verändert Abo-Treffer nicht', async () => {
		const ids = await seedFeed(3);
		await setPaperState(database.db, alice, ids[2] as number, 'saved', true);
		await new Promise((r) => setTimeout(r, 10));
		await setPaperState(database.db, alice, ids[0] as number, 'saved', true);
		expect((await savedPapers(database.db, alice)).items.map((c) => c.paperId)).toEqual([
			ids[0],
			ids[2]
		]);
		const [m] = await database.db
			.select()
			.from(matches)
			.where(and(eq(matches.userId, alice), eq(matches.paperId, ids[0] as number)));
		expect(m?.relevance).toBeGreaterThan(0);
		expect(m?.savedAt).toBeInstanceOf(Date);
	});

	it('Suche: Websuche-Syntax, Titeltreffer zuerst, leere/ungültige Anfragen', async () => {
		const title = await upsertPaper(
			database.db,
			makePaper({ title: 'Graph neural networks', abstract: 'x' })
		);
		const abs = await upsertPaper(
			database.db,
			makePaper({ title: 'Other', abstract: 'We use graph neural networks here.' })
		);
		await upsertPaper(database.db, makePaper({ title: 'Graph theory', abstract: 'no nets' }));
		expect(
			(await searchPage(database.db, alice, 'graph neural')).items.map((c) => c.paperId)
		).toEqual([title.paperId, abs.paperId]);
		expect((await searchPage(database.db, alice, 'graph -neural')).items).toHaveLength(1);
		expect((await searchPage(database.db, alice, '   ')).items).toEqual([]);
		expect((await searchPage(database.db, alice, '"unclosed ( ) & |')).items).toEqual([]);
	});

	it('Detail: alle Autoren, IDs; Abstract nur bei offener Lizenz', async () => {
		const open = await upsertPaper(
			database.db,
			makePaper({
				ids: { arxivId: '2611.00042', doi: '10.1000/open' },
				abstract: 'Open',
				abstractLicenseOk: true,
				authors: Array.from({ length: 12 }, (_, i) => ({ name: `A${i}` }))
			})
		);
		const closed = await upsertPaper(
			database.db,
			makePaper({
				source: 'europepmc',
				ids: { europepmcId: 'MED/7', pmid: '7' },
				abstract: 'Closed',
				abstractLicenseOk: false
			})
		);
		const o = await paperDetail(database.db, alice, open.paperId);
		expect(o?.authors).toHaveLength(12);
		expect(o?.ids).toEqual({ arxivId: '2611.00042', doi: '10.1000/open' });
		expect(o?.abstract).toBe('Open');
		const c = await paperDetail(database.db, alice, closed.paperId);
		expect(c?.abstract).toBeNull();
		expect(c?.ids).toEqual({ europepmcId: 'MED/7', pmid: '7' });
		expect(await paperDetail(database.db, alice, 123_456)).toBeNull();
		const count = await database.db.select({ n: sql<number>`count(*)::int` }).from(matches);
		expect(count[0]?.n).toBe(0);
	});
});
