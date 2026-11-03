import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/app';
import { feedForUser } from '$lib/server/feed';
import { loadRankingConfig } from '$lib/server/ranking/score';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const session = await locals.auth();
	if (!session?.user?.id) return { feed: null };
	const feed = await feedForUser(getDb(), session.user.id, {
		now: new Date(),
		halfLifeDays: loadRankingConfig(env).halfLifeDays,
		limit: 30
	});
	return { feed };
};
