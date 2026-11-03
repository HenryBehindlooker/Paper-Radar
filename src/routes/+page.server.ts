import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/app';
import { feedPage, parseFeedFilter, parsePage } from '$lib/server/papers-view';
import { loadRankingConfig } from '$lib/server/ranking/score';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = await locals.auth();
	if (!session?.user?.id) return { feed: null, filter: 'alle' as const };
	const filter = parseFeedFilter(url.searchParams.get('filter'));
	const feed = await feedPage(getDb(), session.user.id, {
		now: new Date(),
		halfLifeDays: loadRankingConfig(env).halfLifeDays,
		filter,
		page: parsePage(url.searchParams.get('seite'))
	});
	return { feed, filter };
};
