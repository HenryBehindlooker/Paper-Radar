import { json } from '@sveltejs/kit';
import { getBoss, getDb } from '$lib/server/app';
import { healthReport } from '$lib/server/health';
import type { RequestHandler } from './$types';

/**
 * Gesundheitsstatus inkl. Datenbank, Queue (Worker-Herzschlag, Warteschlangen) und Quellen.
 * 503, wenn Datenbank oder Queue nicht erreichbar sind; sonst 200 („ok“ oder „degraded“).
 */
export const GET: RequestHandler = async () => {
	const { report, httpStatus } = await healthReport({ db: getDb(), getBoss });
	return json(report, { status: httpStatus, headers: { 'Cache-Control': 'no-store' } });
};
