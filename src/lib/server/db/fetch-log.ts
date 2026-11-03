import { sql } from 'drizzle-orm';
import type { SourceName } from '../sources/types';
import type { DbOrTx } from './index';
import { fetchLog } from './schema';

export interface FetchLogEntry {
	source: SourceName;
	kind: string;
	sourceQueryId?: number | null;
	startedAt: Date;
	finishedAt: Date;
	status: 'ok' | 'error' | 'skipped';
	itemCount?: number;
	newPaperCount?: number;
	error?: string | null;
	detail?: Record<string, unknown> | null;
}

export async function logFetch(db: DbOrTx, entry: FetchLogEntry): Promise<void> {
	await db.insert(fetchLog).values({
		source: entry.source,
		kind: entry.kind,
		sourceQueryId: entry.sourceQueryId ?? null,
		startedAt: entry.startedAt,
		finishedAt: entry.finishedAt,
		status: entry.status,
		itemCount: entry.itemCount ?? 0,
		newPaperCount: entry.newPaperCount ?? 0,
		error: entry.error ? entry.error.slice(0, 2000) : null,
		detail: entry.detail ?? null
	});
}

export interface SourceHealth {
	source: SourceName;
	lastRunAt: Date | null;
	lastSuccessAt: Date | null;
	lastStatus: 'ok' | 'error' | 'skipped' | null;
	lastError: string | null;
}

/** Letzter Stand je Quelle (für /api/health und die Über-Seite). */
export async function sourceHealth(db: DbOrTx): Promise<SourceHealth[]> {
	const result = await db.execute<{
		source: SourceName;
		last_run_at: Date | null;
		last_success_at: Date | null;
		last_status: 'ok' | 'error' | 'skipped' | null;
		last_error: string | null;
	}>(sql`
		SELECT s.source,
			(SELECT max(finished_at) FROM fetch_log f WHERE f.source = s.source) AS last_run_at,
			(SELECT max(finished_at) FROM fetch_log f WHERE f.source = s.source AND f.status = 'ok') AS last_success_at,
			(SELECT status FROM fetch_log f WHERE f.source = s.source ORDER BY finished_at DESC LIMIT 1) AS last_status,
			(SELECT error FROM fetch_log f WHERE f.source = s.source ORDER BY finished_at DESC LIMIT 1) AS last_error
		FROM unnest(enum_range(NULL::source_name)) AS s(source)
		ORDER BY s.source`);
	return result.rows.map((r) => ({
		source: r.source,
		lastRunAt: r.last_run_at ? new Date(r.last_run_at) : null,
		lastSuccessAt: r.last_success_at ? new Date(r.last_success_at) : null,
		lastStatus: r.last_status,
		lastError: r.last_error
	}));
}
