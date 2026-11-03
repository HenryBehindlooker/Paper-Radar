import { error, type RequestEvent } from '@sveltejs/kit';
import { APP_NAME, APP_VERSION, REPO_URL } from '../config';
import { listSubscriptions } from '../subscriptions';
import { appKeys, appOrigin, getDb } from '../app';
import { feedEntries, feedUrls, ownsSubscription, resolveFeedToken } from './service';
import { buildAtom, buildRss, type FeedMeta } from './xml';

const TYPE_LABEL = { keyword: 'Stichwort', category: 'Kategorie', author: 'Autor:in' } as const;

/** Liefert RSS oder Atom für eine geheime Feed-URL (unbekannt/ungültig → 404). */
export async function feedResponse(event: RequestEvent, format: 'rss' | 'atom'): Promise<Response> {
	const token = event.params.token ?? '';
	const db = getDb();
	const owner = await resolveFeedToken(db, appKeys().feed, token);
	if (!owner) error(404, 'Feed nicht gefunden');

	let subscriptionId: number | undefined;
	let title = `${APP_NAME} – alle Treffer`;
	const abo = event.url.searchParams.get('abo');
	if (abo !== null) {
		subscriptionId = Number(abo);
		if (
			!Number.isSafeInteger(subscriptionId) ||
			!(await ownsSubscription(db, owner.userId, subscriptionId))
		) {
			error(404, 'Feed nicht gefunden');
		}
		const sub = (await listSubscriptions(db, owner.userId)).find((s) => s.id === subscriptionId);
		if (sub) title = `${APP_NAME} – ${TYPE_LABEL[sub.type]}: ${sub.query}`;
	}

	const origin = appOrigin(event.url.origin);
	const entries = await feedEntries(db, owner.userId, {
		origin,
		...(subscriptionId !== undefined ? { subscriptionId } : {})
	});
	const updated = entries.reduce((max, e) => (e.updated > max ? e.updated : max), new Date(0));
	const lastModified = new Date(Math.floor(updated.getTime() / 1000) * 1000);
	const ifModifiedSince = Date.parse(event.request.headers.get('if-modified-since') ?? '');
	const headers: Record<string, string> = {
		'Content-Type':
			format === 'rss'
				? 'application/rss+xml; charset=utf-8'
				: 'application/atom+xml; charset=utf-8',
		'Cache-Control': 'private, max-age=900',
		'Last-Modified': lastModified.toUTCString(),
		'X-Robots-Tag': 'noindex, nofollow',
		'Referrer-Policy': 'no-referrer'
	};
	if (!Number.isNaN(ifModifiedSince) && lastModified.getTime() <= ifModifiedSince) {
		return new Response(null, { status: 304, headers });
	}

	const urls = feedUrls(origin, token, subscriptionId);
	const meta: FeedMeta = {
		title,
		description: 'Neue wissenschaftliche Paper zu deinen Abos – ohne Tracking.',
		homeUrl: urls.html,
		selfUrl: format === 'rss' ? urls.rss : urls.atom,
		updated: entries.length ? updated : new Date(),
		generator: `${APP_NAME} ${APP_VERSION} (${REPO_URL})`
	};
	const body = format === 'rss' ? buildRss(meta, entries) : buildAtom(meta, entries);
	return new Response(body, { headers });
}
