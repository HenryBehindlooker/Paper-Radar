import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { APP_VERSION } from './config';
import type { DbOrTx } from './db/index';
import { sourceHealth, type SourceHealth } from './db/fetch-log';
import { QUEUES } from './jobs/queues';

/**
 * Gesundheitsstatus für /api/health (Docker-Healthcheck und Monitoring).
 *  - 503, wenn Datenbank oder Queue nicht erreichbar sind (Container ungesund)
 *  - 200 mit status „degraded“, wenn der Worker fehlt oder eine Quelle zuletzt fehlschlug –
 *    der Ausfall einer Quelle macht die App nicht ungesund, ist aber sichtbar.
 */

export interface ComponentStatus {
	ok: boolean;
	latencyMs?: number;
	error?: string;
}

export interface QueueStatus extends ComponentStatus {
	worker?: { live: boolean; heartbeatOn: string | null };
	queues?: Record<string, { queued: number; active: number; failed: number }>;
}

export interface SourceStatus {
	source: string;
	status: 'ok' | 'error' | 'skipped' | 'never';
	lastRunAt: string | null;
	lastSuccessAt: string | null;
	error?: string;
}

export interface HealthReport {
	status: 'ok' | 'degraded' | 'error';
	version: string;
	time: string;
	db: ComponentStatus;
	queue: QueueStatus;
	sources: SourceStatus[];
}

const TIMEOUT_MS = 3000;

async function withTimeout<T>(promise: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Zeitüberschreitung nach ${ms} ms`)), ms);
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

const message = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).slice(0, 200);

export function toSourceStatus(h: SourceHealth): SourceStatus {
	return {
		source: h.source,
		status: h.lastStatus ?? 'never',
		lastRunAt: h.lastRunAt?.toISOString() ?? null,
		lastSuccessAt: h.lastSuccessAt?.toISOString() ?? null,
		...(h.lastStatus === 'error' && h.lastError ? { error: h.lastError.slice(0, 200) } : {})
	};
}

/** Gesamtstatus und HTTP-Code aus den Einzelteilen (reine Funktion). */
export function summarize(
	db: ComponentStatus,
	queue: QueueStatus,
	sources: readonly SourceStatus[]
): { status: HealthReport['status']; httpStatus: number } {
	if (!db.ok || !queue.ok) return { status: 'error', httpStatus: 503 };
	const workerDown = queue.worker !== undefined && !queue.worker.live;
	const sourceDown = sources.some((s) => s.status === 'error');
	return { status: workerDown || sourceDown ? 'degraded' : 'ok', httpStatus: 200 };
}

export async function healthReport(deps: {
	db: DbOrTx;
	getBoss: () => Promise<PgBoss>;
	now?: () => Date;
}): Promise<{ report: HealthReport; httpStatus: number }> {
	const now = deps.now ?? (() => new Date());

	const db: ComponentStatus = { ok: false };
	const dbStart = performance.now();
	try {
		await withTimeout(deps.db.execute(sql`SELECT 1`));
		db.ok = true;
		db.latencyMs = Math.round(performance.now() - dbStart);
	} catch (error) {
		db.error = message(error);
	}

	const queue: QueueStatus = { ok: false };
	try {
		const boss = await withTimeout(deps.getBoss());
		const [queues, instances] = await withTimeout(
			Promise.all([boss.getQueues(Object.values(QUEUES)), boss.getInstances()])
		);
		queue.ok = true;
		queue.queues = Object.fromEntries(
			queues.map((q) => [
				q.name,
				{ queued: q.queuedCount, active: q.activeCount, failed: q.failedCount }
			])
		);
		const workers = instances.filter((i) => i.name === 'worker');
		const live = workers.find((i) => i.live);
		const latest =
			live ?? workers.sort((a, b) => b.heartbeatOn.getTime() - a.heartbeatOn.getTime())[0];
		queue.worker = { live: Boolean(live), heartbeatOn: latest?.heartbeatOn?.toISOString() ?? null };
	} catch (error) {
		queue.error = message(error);
	}

	let sources: SourceStatus[] = [];
	if (db.ok) {
		try {
			sources = (await withTimeout(sourceHealth(deps.db))).map(toSourceStatus);
		} catch {
			sources = [];
		}
	}

	const { status, httpStatus } = summarize(db, queue, sources);
	return {
		httpStatus,
		report: { status, version: APP_VERSION, time: now().toISOString(), db, queue, sources }
	};
}
