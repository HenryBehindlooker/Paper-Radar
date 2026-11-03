import { getDb } from '$lib/server/app';
import { parsePage, searchPage } from '$lib/server/papers-view';
import { requireUserId } from '$lib/server/session';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = await requireUserId(locals);
	const q = (url.searchParams.get('q') ?? '').trim();
	const results = q
		? await searchPage(getDb(), userId, q, { page: parsePage(url.searchParams.get('seite')) })
		: null;
	return { q, results };
};
