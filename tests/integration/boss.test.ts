import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { createSubscription } from '$lib/server/db/queries';
import { sourceQueries } from '$lib/server/db/schema';
import {
	createBoss,
	QUEUES,
	registerSchedules,
	registerWorkers,
	requestBackfill,
	SCHEDULE_TZ,
	setupQueues
} from '$lib/server/jobs/queues';
import {
	closeTestDatabase,
	createUser,
	fakeSources,
	hasTestDb,
	jobContext,
	makePaper,
	resetDatabase,
	TEST_DATABASE_URL,
	testDatabase
} from './helpers';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error('Zeitüberschreitung beim Warten');
}

describe.skipIf(!hasTestDb)('pg-boss: Queues, Zeitpläne, Worker', () => {
	let database: Database;
	let boss: PgBoss;

	beforeAll(async () => {
		database = await testDatabase();
		await resetDatabase(database.db);
		boss = createBoss(TEST_DATABASE_URL as string, 'worker');
		boss.on('error', (e) => console.error(e));
		await boss.start();
		for (const q of Object.values(QUEUES)) {
			if (await boss.getQueue(q)) await boss.deleteAllJobs(q);
		}
	});
	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await closeTestDatabase();
	});

	it('legt alle Queues an und registriert die Zeitpläne in Europe/Berlin', async () => {
		await setupQueues(boss);
		await setupQueues(boss); // idempotent
		const names = (await boss.getQueues()).map((q) => q.name);
		for (const q of Object.values(QUEUES)) expect(names).toContain(q);

		await registerSchedules(boss);
		const schedules = await boss.getSchedules();
		const byName = Object.fromEntries(schedules.map((s) => [s.name, s]));
		expect(byName[QUEUES.ingestArxiv]).toMatchObject({
			cron: '17 7 * * 1-5',
			timezone: SCHEDULE_TZ
		});
		expect(byName[QUEUES.ingestQueries]).toMatchObject({ cron: '43 5 * * *' });
		expect(byName[QUEUES.cleanup]).toBeDefined();
	});

	it('Backfill-Anfragen werden pro Query zusammengefasst und vom Worker abgearbeitet', async () => {
		const userId = await createUser(database.db, 'boss@example.org');
		const sub = await createSubscription(database.db, {
			userId,
			type: 'keyword',
			query: 'graph neural networks'
		});

		await requestBackfill(boss, database.db, sub.sourceQueryId);
		await requestBackfill(boss, database.db, sub.sourceQueryId);
		const queued = await boss.findJobs(QUEUES.backfill, { queued: true });
		expect(queued).toHaveLength(1);
		const [pending] = await database.db.select().from(sourceQueries);
		expect(pending?.backfillStatus).toBe('pending');

		const { europepmc, sources } = fakeSources();
		europepmc.result = [makePaper({ source: 'europepmc', ids: { doi: '10.1000/boss' } })];
		await registerWorkers(boss, jobContext(database.db, sources, new Date()));

		await waitFor(async () => {
			const [row] = await database.db
				.select({ status: sourceQueries.backfillStatus })
				.from(sourceQueries)
				.where(eq(sourceQueries.id, sub.sourceQueryId));
			return row?.status === 'done';
		});
		expect(europepmc.searches).toHaveLength(1);
	});
});
