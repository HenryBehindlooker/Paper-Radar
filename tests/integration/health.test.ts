import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '$lib/server/db/index';
import { logFetch } from '$lib/server/db/fetch-log';
import { healthReport } from '$lib/server/health';
import { createBoss, setupQueues } from '$lib/server/jobs/queues';
import {
	closeTestDatabase,
	hasTestDb,
	resetDatabase,
	TEST_DATABASE_URL,
	testDatabase
} from './helpers';

describe.skipIf(!hasTestDb)('/api/health – Gesamtbericht', () => {
	let database: Database;
	let boss: PgBoss;

	beforeAll(async () => {
		database = await testDatabase();
		await resetDatabase(database.db);
		boss = createBoss(TEST_DATABASE_URL as string, 'app');
		await boss.start();
		await setupQueues(boss);
	});
	afterAll(async () => {
		await boss?.stop({ graceful: false });
		await closeTestDatabase();
	});

	it('meldet DB, Queues und Quellen; Quellenfehler → degraded (200)', async () => {
		const at = new Date();
		await logFetch(database.db, {
			source: 'arxiv',
			kind: 'rss',
			startedAt: at,
			finishedAt: at,
			status: 'ok'
		});
		await logFetch(database.db, {
			source: 'europepmc',
			kind: 'search',
			startedAt: at,
			finishedAt: at,
			status: 'error',
			error: 'HTTP 503 für https://www.ebi.ac.uk/…'
		});
		const { report, httpStatus } = await healthReport({
			db: database.db,
			getBoss: async () => boss
		});
		expect(httpStatus).toBe(200);
		expect(report.status).toBe('degraded');
		expect(report.db.ok).toBe(true);
		expect(report.queue.ok).toBe(true);
		expect(Object.keys(report.queue.queues ?? {})).toEqual(
			expect.arrayContaining([
				'ingest-arxiv-daily',
				'backfill',
				'match',
				'weekly-digest',
				'enrich-openalex'
			])
		);
		// Kein Worker gestartet → nicht live
		expect(report.queue.worker?.live).toBe(false);
		const bySource = Object.fromEntries(report.sources.map((s) => [s.source, s]));
		expect(bySource.arxiv?.status).toBe('ok');
		expect(bySource.europepmc).toMatchObject({
			status: 'error',
			error: 'HTTP 503 für https://www.ebi.ac.uk/…'
		});
		expect(bySource.openalex?.status).toBe('never');
	});

	it('Queue nicht erreichbar → 503, ohne zu hängen', async () => {
		const started = Date.now();
		const { report, httpStatus } = await healthReport({
			db: database.db,
			getBoss: () => new Promise<PgBoss>(() => {}) // hängt für immer
		});
		expect(httpStatus).toBe(503);
		expect(report.status).toBe('error');
		expect(report.queue.error).toMatch(/Zeitüberschreitung/);
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
