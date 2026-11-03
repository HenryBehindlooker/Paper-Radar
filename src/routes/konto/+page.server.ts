import { error, fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { appKeys, appOrigin, getDb } from '$lib/server/app';
import { users } from '$lib/server/db/schema';
import { setWeeklyDigest } from '$lib/server/digest';
import {
	disableFeed,
	enableFeed,
	feedToken,
	feedUrls,
	rotateFeed
} from '$lib/server/feeds/service';
import { requireUserId } from '$lib/server/session';
import { deleteAccount, listSubscriptions } from '$lib/server/subscriptions';
import { t } from '$lib/i18n';
import type { Actions, PageServerLoad } from './$types';

/** Mögliche Namen des Auth.js-Session-Cookies (mit/ohne HTTPS-Präfix). */
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

export const load: PageServerLoad = async ({ locals, url }) => {
	const session = await locals.auth();
	if (!session?.user?.id) error(401, 'Nicht angemeldet');
	const db = getDb();
	const [user] = await db
		.select({ feedId: users.feedId, weeklyDigest: users.weeklyDigest })
		.from(users)
		.where(eq(users.id, session.user.id));
	let feed: null | {
		rss: string;
		atom: string;
		perSubscription: Array<{ id: number; label: string; rss: string }>;
	} = null;
	if (user?.feedId) {
		const origin = appOrigin(url.origin);
		const token = feedToken(appKeys().feed, user.feedId);
		const urls = feedUrls(origin, token);
		const subs = await listSubscriptions(db, session.user.id);
		feed = {
			rss: urls.rss,
			atom: urls.atom,
			perSubscription: subs.map((s) => ({
				id: s.id,
				label: s.query,
				rss: feedUrls(origin, token, s.id).rss
			}))
		};
	}
	return { email: session.user.email, feed, weeklyDigest: user?.weeklyDigest ?? false };
};

export const actions: Actions = {
	feedEnable: async ({ locals }) => {
		await enableFeed(getDb(), await requireUserId(locals));
		return { feed: 'enabled' };
	},
	feedRotate: async ({ locals }) => {
		await rotateFeed(getDb(), await requireUserId(locals));
		return { feed: 'rotated' };
	},
	feedDisable: async ({ locals }) => {
		await disableFeed(getDb(), await requireUserId(locals));
		return { feed: 'disabled' };
	},
	digest: async ({ locals, request }) => {
		const form = await request.formData();
		await setWeeklyDigest(getDb(), await requireUserId(locals), form.get('enabled') === 'true');
		return { digest: 'saved' };
	},
	delete: async ({ locals, request, cookies }) => {
		const session = await locals.auth();
		if (!session?.user?.id) error(401, 'Nicht angemeldet');
		const form = await request.formData();
		const confirmation = String(form.get('confirm') ?? '')
			.trim()
			.toLowerCase();
		if (confirmation !== session.user.email.toLowerCase()) {
			return fail(400, { error: t('account.delete.mismatch') });
		}
		await deleteAccount(getDb(), session.user.id);
		for (const name of SESSION_COOKIES) cookies.delete(name, { path: '/' });
		redirect(303, '/?konto=geloescht');
	}
};
