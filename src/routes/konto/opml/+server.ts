import { error } from '@sveltejs/kit';
import { APP_NAME } from '$lib/server/config';
import { appKeys, appOrigin, getDb } from '$lib/server/app';
import { users } from '$lib/server/db/schema';
import { feedToken, opmlOutlines } from '$lib/server/feeds/service';
import { buildOpml } from '$lib/server/feeds/xml';
import { requireUserId } from '$lib/server/session';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

/** OPML mit dem persönlichen Feed und einem Feed je Abo (zum Import in Feed-Reader). */
export const GET: RequestHandler = async ({ locals, url }) => {
	const userId = await requireUserId(locals);
	const db = getDb();
	const [user] = await db.select({ feedId: users.feedId }).from(users).where(eq(users.id, userId));
	if (!user?.feedId) error(409, 'Der persönliche Feed ist nicht aktiviert');
	const token = feedToken(appKeys().feed, user.feedId);
	const outlines = await opmlOutlines(db, userId, appOrigin(url.origin), token);
	return new Response(buildOpml(`${APP_NAME} – meine Feeds`, new Date(), outlines), {
		headers: {
			'Content-Type': 'text/x-opml; charset=utf-8',
			'Content-Disposition': 'attachment; filename="paper-radar-feeds.opml"',
			'Cache-Control': 'private, no-store'
		}
	});
};
