import { eq } from 'drizzle-orm';
import { PgBoss, type Queue } from 'pg-boss';
import type { Db } from '../db/index';
import { sourceQueries } from '../db/schema';
import { runWeeklyDigest } from '../digest';
import { enrichWithOpenAlex } from '../enrichment/openalex';
import { runMatching } from '../ranking/match';
import type { JobContext } from './context';
import {
	backfillSourceQuery,
	cleanup,
	enrichWithCrossref,
	ingestArxivDaily,
	ingestSourceQueries
} from './ingest';

/** Zeitzone aller Zeitpläne. */
export const SCHEDULE_TZ = 'Europe/Berlin';

export const QUEUES = {
	ingestArxiv: 'ingest-arxiv-daily',
	ingestQueries: 'ingest-queries-daily',
	backfill: 'backfill',
	enrichCrossref: 'enrich-crossref',
	match: 'match',
	weeklyDigest: 'weekly-digest',
	enrichOpenalex: 'enrich-openalex',
	cleanup: 'cleanup'
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * `stately`: höchstens ein wartender und ein laufender Job je Queue (bzw. je
 * `singletonKey`) – verhindert Stau und doppelte Upstream-Abfragen.
 */
export const QUEUE_DEFINITIONS: Array<Queue> = [
	{
		name: QUEUES.ingestArxiv,
		policy: 'stately',
		retryLimit: 3,
		retryDelay: 600,
		retryBackoff: true,
		expireInSeconds: 3600
	},
	{
		name: QUEUES.ingestQueries,
		policy: 'stately',
		retryLimit: 2,
		retryDelay: 900,
		retryBackoff: true,
		expireInSeconds: 4 * 3600
	},
	{
		name: QUEUES.backfill,
		policy: 'stately',
		retryLimit: 2,
		retryDelay: 300,
		retryBackoff: true,
		expireInSeconds: 3600
	},
	{
		name: QUEUES.enrichCrossref,
		policy: 'stately',
		retryLimit: 2,
		retryDelay: 300,
		retryBackoff: true,
		expireInSeconds: 3600
	},
	{
		name: QUEUES.match,
		policy: 'stately',
		retryLimit: 3,
		retryDelay: 60,
		retryBackoff: true,
		expireInSeconds: 1800
	},
	{
		name: QUEUES.enrichOpenalex,
		policy: 'stately',
		retryLimit: 2,
		retryDelay: 1800,
		retryBackoff: true,
		expireInSeconds: 4 * 3600
	},
	{
		name: QUEUES.weeklyDigest,
		policy: 'stately',
		retryLimit: 3,
		retryDelay: 600,
		retryBackoff: true,
		expireInSeconds: 3600
	},
	{ name: QUEUES.cleanup, policy: 'stately', retryLimit: 1, expireInSeconds: 3600 }
];

/**
 * Zeitpläne (Europe/Berlin). arXiv veröffentlicht die Ankündigungen um Mitternacht
 * US-Ostküstenzeit (≈ 6 Uhr in Berlin), nur werktags.
 */
export const SCHEDULES: Array<{ name: QueueName; cron: string }> = [
	{ name: QUEUES.ingestQueries, cron: '43 5 * * *' },
	{ name: QUEUES.ingestArxiv, cron: '17 7 * * 1-5' },
	{ name: QUEUES.enrichCrossref, cron: '7 9 * * *' },
	// Sicherheitsnetz; regulär läuft das Matching direkt nach jeder Ingestion.
	{ name: QUEUES.match, cron: '37 */6 * * *' },
	{ name: QUEUES.cleanup, cron: '27 3 * * *' },
	// Sonntagmorgen, damit die Zitationszahlen zur Wochen-Mail aktuell sind.
	{ name: QUEUES.enrichOpenalex, cron: '13 4 * * 0' },
	// Montag 7:00 Uhr (Europe/Berlin), wie gefordert exakt zur vollen Stunde.
	{ name: QUEUES.weeklyDigest, cron: '0 7 * * 1' }
];

export interface BackfillJobData {
	sourceQueryId: number;
}

export type BossRole = 'worker' | 'app';

/**
 * pg-boss-Instanz. Der Worker verwaltet Wartung und Zeitpläne; die App reiht nur ein.
 * Schema `pgboss` in derselben Datenbank.
 */
export function createBoss(connectionString: string, role: BossRole): PgBoss {
	return new PgBoss({
		connectionString,
		schema: 'pgboss',
		application_name: `paper-radar-${role}`,
		instanceName: role,
		max: role === 'worker' ? 5 : 2,
		supervise: role === 'worker',
		schedule: role === 'worker'
	});
}

export async function setupQueues(boss: PgBoss): Promise<void> {
	const existing = new Set((await boss.getQueues()).map((q) => q.name));
	for (const def of QUEUE_DEFINITIONS) {
		const { name, policy, partition, ...options } = def;
		// Policy und Partitionierung sind nach dem Anlegen unveränderlich (pg-boss).
		if (existing.has(name)) await boss.updateQueue(name, options);
		else await boss.createQueue(name, { ...options, policy, partition });
	}
}

export async function registerSchedules(boss: PgBoss): Promise<void> {
	for (const s of SCHEDULES) await boss.schedule(s.name, s.cron, null, { tz: SCHEDULE_TZ });
}

/**
 * Reiht einen Backfill für ein (dedupliziertes) Query ein. Einziger Weg, wie eine
 * Nutzeraktion zu Upstream-Abfragen führt – asynchron, gebündelt und limitiert.
 */
export async function requestBackfill(boss: PgBoss, db: Db, sourceQueryId: number): Promise<void> {
	await db
		.update(sourceQueries)
		.set({ backfillStatus: 'pending', backfillRequestedAt: new Date(), backfillError: null })
		.where(eq(sourceQueries.id, sourceQueryId));
	await boss.send(QUEUES.backfill, { sourceQueryId } satisfies BackfillJobData, {
		singletonKey: `sq:${sourceQueryId}`
	});
}

/** Matching anstoßen (gebündelt: höchstens ein wartender Job; nur lokale DB-Arbeit). */
export async function requestMatching(boss: PgBoss): Promise<void> {
	await boss.send(QUEUES.match, null);
}

/** Nach neuer Ingestion: Matching und Crossref-Ergänzung anstoßen (gebündelt). */
async function chainEnrichment(boss: PgBoss, newPaperIds: number[]): Promise<void> {
	if (newPaperIds.length === 0) return;
	await requestMatching(boss);
	await boss.send(QUEUES.enrichCrossref, null);
}

export async function registerWorkers(boss: PgBoss, ctx: JobContext): Promise<void> {
	const options = { localConcurrency: 1, batchSize: 1 } as const;
	const log = ctx.logger;

	await boss.work(QUEUES.ingestArxiv, options, async () => {
		const result = await ingestArxivDaily(ctx);
		log.info('arXiv RSS ingestiert', {
			neu: result.newPaperIds.length,
			fehler: result.errors.length
		});
		await chainEnrichment(boss, result.newPaperIds);
		return { newPapers: result.newPaperIds.length, errors: result.errors };
	});

	await boss.work(QUEUES.ingestQueries, options, async () => {
		const result = await ingestSourceQueries(ctx);
		log.info('Abo-Queries ingestiert', {
			neu: result.newPaperIds.length,
			fehler: result.errors.length
		});
		await chainEnrichment(boss, result.newPaperIds);
		return { newPapers: result.newPaperIds.length, errors: result.errors };
	});

	await boss.work<BackfillJobData>(QUEUES.backfill, options, async ([job]) => {
		if (!job) return null;
		const result = await backfillSourceQuery(ctx, job.data.sourceQueryId);
		log.info('Backfill fertig', {
			sourceQueryId: job.data.sourceQueryId,
			status: result.status,
			neu: result.newPaperIds.length
		});
		await chainEnrichment(boss, result.newPaperIds);
		return { status: result.status, newPapers: result.newPaperIds.length, errors: result.errors };
	});

	await boss.work(QUEUES.enrichCrossref, options, async () => {
		const result = await enrichWithCrossref(ctx);
		log.info('Crossref-Ergänzung', { ...result });
		return result;
	});

	await boss.work(QUEUES.match, options, async () => {
		return runMatching(ctx);
	});

	await boss.work(QUEUES.enrichOpenalex, options, async () => {
		if (!ctx.enrichment) return { status: 'disabled' };
		const result = await enrichWithOpenAlex({
			db: ctx.db,
			logger: log,
			now: ctx.now,
			...ctx.enrichment
		});
		// Budget erreicht: sauber pausieren und nach dem Reset fortsetzen.
		if (result.status === 'paused' && result.resumeAt && result.remaining > 0) {
			await boss.sendAfter(QUEUES.enrichOpenalex, null, null, result.resumeAt);
			log.info('OpenAlex-Anreicherung pausiert', {
				reason: result.reason,
				remaining: result.remaining,
				resumeAt: result.resumeAt.toISOString()
			});
		}
		return result;
	});

	await boss.work(QUEUES.weeklyDigest, options, async () => {
		if (!ctx.digest) {
			log.warn('Wochen-Mail übersprungen: ORIGIN oder AUTH_SECRET nicht gesetzt');
			return { skipped: true };
		}
		return runWeeklyDigest({
			db: ctx.db,
			logger: log,
			now: ctx.now,
			halfLifeDays: ctx.ranking?.halfLifeDays ?? 7,
			...ctx.digest
		});
	});

	await boss.work(QUEUES.cleanup, options, async () => {
		const result = await cleanup(ctx);
		log.info('Aufräumen', { ...result });
		return result;
	});
}
