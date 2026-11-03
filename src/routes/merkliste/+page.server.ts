import { getDb } from '$lib/server/app';
import { parsePage, savedPapers } from '$lib/server/papers-view';
import { requireUserId } from '$lib/server/session';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = await requireUserId(locals);
	const saved = await savedPapers(getDb(), userId, {
		page: parsePage(url.searchParams.get('seite'))
	});
	return { saved };
};
