import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/app';
import { listSubscriptions } from '$lib/server/subscriptions';
import type { RequestHandler } from './$types';

/** Eigene Abos inkl. Backfill-Status (JSON). Zugriff nur angemeldet (hooks.server.ts). */
export const GET: RequestHandler = async ({ locals }) => {
	const session = await locals.auth();
	if (!session?.user?.id) return json({ error: 'Nicht angemeldet' }, { status: 401 });
	const subscriptions = await listSubscriptions(getDb(), session.user.id);
	return json({ subscriptions });
};
