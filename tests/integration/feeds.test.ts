import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import { createSubscription } from '$lib/server/db/queries';
import { matches, users } from '$lib/server/db/schema';
import {
	runWeeklyDigest,
	setWeeklyDigest,
	unsubscribeByToken,
	unsubscribeToken,
	type OutgoingMail
} from '$lib/server/digest';
import {
	disableFeed,
	enableFeed,
	feedEntries,
	feedToken,
	opmlOutlines,
	ownsSubscription,
	resolveFeedToken,
	rotateFeed
} from '$lib/server/feeds/service';
import { silentLogger } from '$lib/server/log';
import { setPaperState } from '$lib/server/papers-view';
import { runMatching } from '$lib/server/ranking/match';
import { deriveKey } from '$lib/server/tokens';
import {
	closeTestDatabase,
	createUser,
	hasTestDb,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

const SECRET = 'integration-secret-0123456789abcdef';
const FEED_KEY = deriveKey(SECRET, 'feed');
const UNSUB_KEY = deriveKey(SECRET, 'digest-unsubscribe');
const ORIGIN = 'https://radar.example.org';
const NOW = new Date('2026-11-09T06:00:00Z'); // Montag, 7 Uhr in Berlin
const DAY = 86_400_000;

describe.skipIf(!hasTestDb)('Persönliche Feeds und Wochen-Mail', () => {
	let database: Database;
	let alice: string;
	let bob: string;

	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		alice = await createUser(database.db, 'alice@example.org');
		bob = await createUser(database.db, 'bob@example.org');
	});
	afterAll(closeTestDatabase);

	/**
	 * n Treffer für eine Person über ein Kategorie-Abo; Paper i wurde vor daysAgo(i) Tagen
	 * erfasst und erschien zu diesem Zeitpunkt im Feed (matches.created_at).
	 */
	async function seed(userId: string, n: number, daysAgo: (i: number) => number = () => 1) {
		const sub = await createSubscription(database.db, { userId, type: 'category', query: 'cs.DL' });
		const ids: number[] = [];
		for (let i = 0; i < n; i++) {
			const at = new Date(NOW.getTime() - daysAgo(i) * DAY);
			const p = await upsertPaper(
				database.db,
				makePaper({
					title: `Library paper ${i}`,
					categories: ['cs.DL'],
					publishedAt: at,
					abstract: `Abstract ${i}`,
					abstractLicenseOk: i % 2 === 0
				}),
				at
			);
			ids.push(p.paperId);
		}
		await runMatching({ db: database.db, logger: silentLogger, now: () => NOW });
		await database.db.execute(sql`
			UPDATE matches m SET created_at = p.first_seen_at
			FROM papers p WHERE p.id = m.paper_id AND m.user_id = ${userId}`);
		return { subscriptionId: sub.subscriptionId, ids };
	}

	describe('Feed-Adresse', () => {
		it('aktivieren, auflösen, rotieren, deaktivieren', async () => {
			const id1 = await enableFeed(database.db, alice);
			expect(await enableFeed(database.db, alice)).toBe(id1); // idempotent
			const t1 = feedToken(FEED_KEY, id1);
			expect(await resolveFeedToken(database.db, FEED_KEY, t1)).toEqual({ userId: alice });
			expect(
				await resolveFeedToken(database.db, deriveKey(SECRET, 'digest-unsubscribe'), t1)
			).toBeNull();
			expect(await resolveFeedToken(database.db, FEED_KEY, `${id1}.falsch`)).toBeNull();

			const id2 = await rotateFeed(database.db, alice);
			expect(id2).not.toBe(id1);
			expect(await resolveFeedToken(database.db, FEED_KEY, t1)).toBeNull();
			expect(await resolveFeedToken(database.db, FEED_KEY, feedToken(FEED_KEY, id2))).toEqual({
				userId: alice
			});

			await disableFeed(database.db, alice);
			expect(await resolveFeedToken(database.db, FEED_KEY, feedToken(FEED_KEY, id2))).toBeNull();
		});

		it('nur die Feed-ID wird gespeichert, nie die Signatur', async () => {
			const id = await enableFeed(database.db, alice);
			const [row] = await database.db.select().from(users).where(eq(users.id, alice));
			expect(row?.feedId).toBe(id);
			expect(JSON.stringify(row)).not.toContain(feedToken(FEED_KEY, id).split('.')[1]);
		});
	});

	describe('Feed-Einträge', () => {
		it('neueste zuerst, ohne Ausgeblendete und reine Merklisten-Einträge; Abstract nur mit Lizenz', async () => {
			const { ids } = await seed(alice, 4, (i) => 4 - i); // id[3] am neuesten
			await setPaperState(database.db, alice, ids[1] as number, 'hidden', true);
			const extra = await upsertPaper(
				database.db,
				makePaper({ title: 'Saved from search', categories: [] })
			);
			await setPaperState(database.db, alice, extra.paperId, 'saved', true);

			const entries = await feedEntries(database.db, alice, { origin: ORIGIN });
			expect(entries.map((e) => e.title)).toEqual([
				'Library paper 3',
				'Library paper 2',
				'Library paper 0'
			]);
			expect(entries[0]?.id).toBe(`urn:paper-radar:paper:${ids[3]}`);
			expect(entries[0]?.summary).toContain('Warum: arXiv-Kategorie cs.DL');
			expect(entries[0]?.summary).toContain(`Details: ${ORIGIN}/paper/${ids[3]}`);
			expect(entries[0]?.summary).not.toContain('Abstract 3'); // Lizenz nicht offen
			expect(entries[1]?.summary).toContain('Abstract 2');
			expect(await feedEntries(database.db, bob, { origin: ORIGIN })).toEqual([]);
		});

		it('Feed je Abo und Eigentümerprüfung', async () => {
			const { subscriptionId } = await seed(alice, 2);
			const kw = await createSubscription(database.db, {
				userId: alice,
				type: 'keyword',
				query: 'paper 1'
			});
			await runMatching({ db: database.db, logger: silentLogger, now: () => NOW });
			const onlyKeyword = await feedEntries(database.db, alice, {
				origin: ORIGIN,
				subscriptionId: kw.subscriptionId
			});
			expect(onlyKeyword.map((e) => e.title)).toEqual(['Library paper 1']);
			expect(
				(await feedEntries(database.db, alice, { origin: ORIGIN, subscriptionId })).length
			).toBe(2);
			expect(await ownsSubscription(database.db, alice, kw.subscriptionId)).toBe(true);
			expect(await ownsSubscription(database.db, bob, kw.subscriptionId)).toBe(false);

			const outlines = await opmlOutlines(database.db, alice, ORIGIN, 'tok.sig');
			expect(outlines.map((o) => o.xmlUrl)).toEqual([
				`${ORIGIN}/feed/tok.sig/rss.xml`,
				`${ORIGIN}/feed/tok.sig/rss.xml?abo=${subscriptionId}`,
				`${ORIGIN}/feed/tok.sig/rss.xml?abo=${kw.subscriptionId}`
			]);
			expect(outlines[2]?.title).toBe('Paper-Radar – Stichwort: paper 1');
		});

		it('höchstens 50 Einträge', async () => {
			await seed(alice, 55, (i) => (i % 7) + 1);
			expect(await feedEntries(database.db, alice, { origin: ORIGIN })).toHaveLength(50);
		});
	});

	describe('Wochen-Mail', () => {
		function context(sent: OutgoingMail[], fail = false) {
			return {
				db: database.db,
				logger: silentLogger,
				now: () => NOW,
				origin: ORIGIN,
				key: UNSUB_KEY,
				halfLifeDays: 7,
				send: async (mail: OutgoingMail) => {
					if (fail) throw new Error('SMTP down');
					sent.push(mail);
				}
			};
		}

		it('nur Opt-in, Top-10 der letzten 7 Tage, ohne Treffer keine Mail, idempotent', async () => {
			await seed(alice, 13, (i) => (i < 12 ? (i % 6) + 1 : 9)); // 12 in der Woche, 1 älter
			await setWeeklyDigest(database.db, alice, true);
			// Bob hat ein Abo, das nichts trifft → keine Mail.
			await createSubscription(database.db, {
				userId: bob,
				type: 'keyword',
				query: 'nonexistent topic'
			});
			await setWeeklyDigest(database.db, bob, true);
			const carol = await createUser(database.db, 'carol@example.org');
			await seed(carol, 3); // nicht eingeschaltet

			const sent: OutgoingMail[] = [];
			const result = await runWeeklyDigest(context(sent));
			expect(result).toEqual({ candidates: 2, sent: 1, skippedEmpty: 1, failed: 0 });
			expect(sent).toHaveLength(1);
			const mail = sent[0] as OutgoingMail;
			expect(mail.to).toBe('alice@example.org');
			expect(mail.subject).toBe('Paper-Radar: Deine 10 wichtigsten Paper der Woche');
			expect(mail.text.match(/^\d+\. /gm)).toHaveLength(10);
			expect(mail.text).not.toContain('Library paper 12'); // älter als 7 Tage
			const unsubscribe = /Abmelden: (\S+)/.exec(mail.text)?.[1] as string;
			expect(mail.headers['List-Unsubscribe']).toBe(`<${unsubscribe}>`);

			// Wiederholung des Jobs (z. B. Retry) verschickt nichts doppelt.
			const again: OutgoingMail[] = [];
			expect((await runWeeklyDigest(context(again))).sent).toBe(0);
			expect(again).toHaveLength(0);
			const [row] = await database.db.select().from(users).where(eq(users.id, alice));
			expect(row?.lastDigestSentAt?.toISOString()).toBe(NOW.toISOString());
		});

		it('Versandfehler markieren nicht als gesendet', async () => {
			await seed(alice, 2);
			await setWeeklyDigest(database.db, alice, true);
			const result = await runWeeklyDigest(context([], true));
			expect(result).toMatchObject({ sent: 0, failed: 1 });
			const [row] = await database.db.select().from(users).where(eq(users.id, alice));
			expect(row?.lastDigestSentAt).toBeNull();
		});

		it('Abmelden per Token', async () => {
			await setWeeklyDigest(database.db, alice, true);
			const token = unsubscribeToken(UNSUB_KEY, alice);
			expect(await unsubscribeByToken(database.db, FEED_KEY, token)).toBe(false);
			expect(await unsubscribeByToken(database.db, UNSUB_KEY, `${alice}.x`)).toBe(false);
			expect(await unsubscribeByToken(database.db, UNSUB_KEY, token)).toBe(true);
			const [row] = await database.db.select().from(users).where(eq(users.id, alice));
			expect(row?.weeklyDigest).toBe(false);
			await database.db.delete(users).where(eq(users.id, alice));
			expect(await unsubscribeByToken(database.db, UNSUB_KEY, token)).toBe(false);
		});

		it('ausgeblendete Treffer kommen nicht in die Mail', async () => {
			const { ids } = await seed(alice, 2);
			await setPaperState(database.db, alice, ids[0] as number, 'hidden', true);
			await setWeeklyDigest(database.db, alice, true);
			const sent: OutgoingMail[] = [];
			await runWeeklyDigest(context(sent));
			expect(sent[0]?.text).not.toContain('Library paper 0');
			expect(sent[0]?.text).toContain('Library paper 1');
			const count = await database.db.select().from(matches).where(eq(matches.userId, alice));
			expect(count).toHaveLength(2);
		});
	});
});
