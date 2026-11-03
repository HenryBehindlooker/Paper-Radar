import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { upsertPaper } from '$lib/server/db/papers';
import {
	matches,
	sessions,
	sourceQueries,
	subscriptions,
	users,
	verificationTokens
} from '$lib/server/db/schema';
import {
	addSubscription,
	deleteAccount,
	listSubscriptions,
	MAX_SUBSCRIPTIONS,
	removeSubscription,
	SubscriptionError,
	updateSubscriptionWeight
} from '$lib/server/subscriptions';
import {
	closeTestDatabase,
	createUser,
	hasTestDb,
	makePaper,
	resetDatabase,
	testDatabase
} from './helpers';

describe.skipIf(!hasTestDb)('Abo-Verwaltung und Konto-Löschung', () => {
	let database: Database;
	let alice: string;
	let bob: string;
	let backfills: number[];
	const requestBackfill = async (id: number) => {
		backfills.push(id);
		// wie requestBackfill(): Status vermerken
		await database.db
			.update(sourceQueries)
			.set({ backfillStatus: 'pending', backfillRequestedAt: new Date() })
			.where(eq(sourceQueries.id, id));
	};

	beforeAll(async () => {
		database = await testDatabase();
	});
	beforeEach(async () => {
		await resetDatabase(database.db);
		backfills = [];
		alice = await createUser(database.db, 'alice@example.org');
		bob = await createUser(database.db, 'bob@example.org');
	});
	afterAll(closeTestDatabase);

	it('reiht Backfill nur für neue bzw. gescheiterte Queries ein', async () => {
		const a = await addSubscription(database.db, requestBackfill, alice, {
			type: 'keyword',
			query: 'Graph Neural Networks'
		});
		expect(a.backfillRequested).toBe(true);
		expect(backfills).toHaveLength(1);

		// Gleiches Query, andere Person → kein zweiter Backfill
		const b = await addSubscription(database.db, requestBackfill, bob, {
			type: 'keyword',
			query: 'graph  neural networks'
		});
		expect(b.backfillRequested).toBe(false);
		expect(backfills).toHaveLength(1);

		// Nach einem Fehlschlag wird beim nächsten Abo erneut nachgeladen
		await database.db.update(sourceQueries).set({ backfillStatus: 'failed' });
		await removeSubscription(database.db, bob, b.subscriptionId);
		const again = await addSubscription(database.db, requestBackfill, bob, {
			type: 'keyword',
			query: 'graph neural networks'
		});
		expect(again.backfillRequested).toBe(true);
		expect(backfills).toHaveLength(2);
	});

	it('listet nur eigene Abos mit Status und Anzahl weiterer Abonnent:innen', async () => {
		await addSubscription(database.db, requestBackfill, alice, {
			type: 'category',
			query: 'cs.DL'
		});
		await addSubscription(database.db, requestBackfill, bob, { type: 'category', query: 'cs.DL' });
		await addSubscription(database.db, requestBackfill, bob, {
			type: 'author',
			query: 'Yang, Rui',
			weight: '2'
		});
		const list = await listSubscriptions(database.db, bob);
		expect(list.map((s) => [s.type, s.query, s.weight, s.backfillStatus, s.sharedWith])).toEqual([
			['category', 'cs.DL', 1, 'pending', 2],
			['author', 'Yang, Rui', 2, 'pending', 1]
		]);
		expect(await listSubscriptions(database.db, alice)).toHaveLength(1);
	});

	it('fremde Abos lassen sich weder löschen noch ändern', async () => {
		const a = await addSubscription(database.db, requestBackfill, alice, {
			type: 'keyword',
			query: 'crispr'
		});
		expect(await removeSubscription(database.db, bob, a.subscriptionId)).toBe(false);
		expect(await updateSubscriptionWeight(database.db, bob, a.subscriptionId, '3')).toBe(false);
		expect(await updateSubscriptionWeight(database.db, alice, a.subscriptionId, '3')).toBe(true);
		const [row] = await database.db.select().from(subscriptions);
		expect(row?.weight).toBe(3);
		await expect(
			updateSubscriptionWeight(database.db, alice, a.subscriptionId, '9')
		).rejects.toBeInstanceOf(SubscriptionError);
	});

	it('begrenzt die Zahl der Abos pro Konto', async () => {
		for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
			await addSubscription(database.db, requestBackfill, alice, {
				type: 'keyword',
				query: `topic${i}`
			});
		}
		await expect(
			addSubscription(database.db, requestBackfill, alice, { type: 'keyword', query: 'one more' })
		).rejects.toThrow(/Maximal/);
	});

	it('ungültige Queries werden als SubscriptionError gemeldet', async () => {
		await expect(
			addSubscription(database.db, requestBackfill, alice, { type: 'author', query: 'x' })
		).rejects.toBeInstanceOf(SubscriptionError);
		expect(backfills).toHaveLength(0);
	});

	it('Konto löschen entfernt alle personenbezogenen Daten', async () => {
		await addSubscription(database.db, requestBackfill, alice, {
			type: 'keyword',
			query: 'crispr'
		});
		await addSubscription(database.db, requestBackfill, bob, { type: 'keyword', query: 'crispr' });
		const paper = await upsertPaper(database.db, makePaper());
		await database.db.insert(matches).values([
			{ userId: alice, paperId: paper.paperId, score: 1, saved: true },
			{ userId: bob, paperId: paper.paperId, score: 1 }
		]);
		await database.db.insert(sessions).values({
			sessionToken: 'tok-alice',
			userId: alice,
			expires: new Date(Date.now() + 86_400_000)
		});
		await database.db.insert(verificationTokens).values({
			identifier: 'alice@example.org',
			token: 'hash',
			expires: new Date(Date.now() + 3_600_000)
		});

		expect(await deleteAccount(database.db, alice)).toBe(true);
		expect(await deleteAccount(database.db, alice)).toBe(false);

		const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n;
		expect(
			await n(
				database.db
					.select({ n: sql<number>`count(*)::int` })
					.from(users)
					.where(eq(users.id, alice))
			)
		).toBe(0);
		expect(await n(database.db.select({ n: sql<number>`count(*)::int` }).from(sessions))).toBe(0);
		expect(
			await n(database.db.select({ n: sql<number>`count(*)::int` }).from(verificationTokens))
		).toBe(0);
		expect(
			await n(
				database.db
					.select({ n: sql<number>`count(*)::int` })
					.from(subscriptions)
					.where(eq(subscriptions.userId, alice))
			)
		).toBe(0);
		expect(
			await n(
				database.db
					.select({ n: sql<number>`count(*)::int` })
					.from(matches)
					.where(eq(matches.userId, alice))
			)
		).toBe(0);
		// Daten anderer bleiben unberührt, das Paper selbst auch.
		expect(await listSubscriptions(database.db, bob)).toHaveLength(1);
		expect(await n(database.db.select({ n: sql<number>`count(*)::int` }).from(matches))).toBe(1);
	});
});
