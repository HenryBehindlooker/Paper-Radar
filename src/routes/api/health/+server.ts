import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Liveness-Endpunkt. DB- und Queue-Status sowie Quellen-Status folgen in
 * späteren Phasen (Phase 2/8).
 */
export const GET: RequestHandler = () => {
	return json({ status: 'ok' });
};
