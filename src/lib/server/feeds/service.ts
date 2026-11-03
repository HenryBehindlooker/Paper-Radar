import { and, desc, eq, sql } from 'drizzle-orm';
import { formatDate } from '../../papers/format';
import { explainReasons } from '../../ranking/reasons';
import type { Db } from '../db/index';
import { matches, papers, subscriptions, users } from '../db/schema';
import { hydrateCards } from '../papers-view';
import { listSubscriptions } from '../subscriptions';
import { newFeedId, signToken, verifyToken } from '../tokens';
import type { FeedEntry, OpmlOutline } from './xml';

/**
 * Persönliche Feeds unter geheimer, rotierbarer URL:
 *   /feed/<feedId>.<signatur>/rss.xml   (bzw. atom.xml, optional ?abo=<id>)
 * Gespeichert wird nur die `feedId`; die Signatur entsteht aus AUTH_SECRET.
 */

export const FEED_LIMIT = 50;

export async function enableFeed(db: Db, userId: string): Promise<string> {
	const [row] = await db.select({ feedId: users.feedId }).from(users).where(eq(users.id, userId));
	if (row?.feedId) return row.feedId;
	const feedId = newFeedId();
	await db.update(users).set({ feedId }).where(eq(users.id, userId));
	return feedId;
}

/** Neue Adresse – die alte ist sofort ungültig. */
export async function rotateFeed(db: Db, userId: string): Promise<string> {
	const feedId = newFeedId();
	await db.update(users).set({ feedId }).where(eq(users.id, userId));
	return feedId;
}

export async function disableFeed(db: Db, userId: string): Promise<void> {
	await db.update(users).set({ feedId: null }).where(eq(users.id, userId));
}

export function feedToken(key: Buffer, feedId: string): string {
	return signToken(key, feedId);
}

export interface FeedUrls {
	rss: string;
	atom: string;
	html: string;
}

export function feedUrls(origin: string, token: string, subscriptionId?: number): FeedUrls {
	const base = `${origin.replace(/\/$/, '')}/feed/${encodeURIComponent(token)}`;
	const qs = subscriptionId ? `?abo=${subscriptionId}` : '';
	return {
		rss: `${base}/rss.xml${qs}`,
		atom: `${base}/atom.xml${qs}`,
		html: origin.replace(/\/$/, '')
	};
}

/** Prüft Signatur und Feed-ID; liefert die zugehörige Person oder `null`. */
export async function resolveFeedToken(
	db: Db,
	key: Buffer,
	token: string
): Promise<{ userId: string } | null> {
	const feedId = verifyToken(key, token);
	if (!feedId) return null;
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.feedId, feedId));
	return row ? { userId: row.id } : null;
}

function summaryOf(card: Awaited<ReturnType<typeof hydrateCards>>[number], origin: string): string {
	const lines: string[] = [];
	if (card.authors.length) {
		lines.push(card.authors.join(', ') + (card.authorCount > card.authors.length ? ' u. a.' : ''));
	}
	lines.push([formatDate(card.publishedAt), card.journal].filter(Boolean).join(' · '));
	const why = explainReasons(card.reasons);
	if (why.length) lines.push(`Warum: ${why.join('; ')}`);
	if (card.abstract) {
		const abstract =
			card.abstract.length > 2000 ? `${card.abstract.slice(0, 2000)} …` : card.abstract;
		lines.push('', abstract);
	}
	lines.push('', `Details: ${origin.replace(/\/$/, '')}/paper/${card.paperId}`);
	return lines.join('\n');
}

/**
 * Feed-Einträge einer Person: neueste Treffer zuerst (Zeitpunkt, an dem das Paper
 * für sie erschien). Ausgeblendete und reine Merklisten-Einträge fehlen.
 * Mit `subscriptionId` nur Treffer dieses (eigenen) Abos.
 */
export async function feedEntries(
	db: Db,
	userId: string,
	options: { origin: string; subscriptionId?: number; limit?: number }
): Promise<FeedEntry[]> {
	const conditions = [
		eq(matches.userId, userId),
		eq(matches.hidden, false),
		sql`jsonb_array_length(${matches.reasons}) > 0`
	];
	if (options.subscriptionId !== undefined) {
		conditions.push(sql`${matches.subscriptionIds} @> ARRAY[${options.subscriptionId}]::bigint[]`);
	}
	const ranked = await db
		.select({ paperId: matches.paperId, createdAt: matches.createdAt })
		.from(matches)
		.innerJoin(papers, eq(papers.id, matches.paperId))
		.where(and(...conditions))
		.orderBy(desc(matches.createdAt), desc(papers.publishedAt), desc(papers.id))
		.limit(options.limit ?? FEED_LIMIT);
	const createdAt = new Map(ranked.map((r) => [r.paperId, r.createdAt]));
	const cards = await hydrateCards(
		db,
		userId,
		ranked.map((r) => ({ paperId: r.paperId, score: null })),
		10
	);
	return cards.map((card) => {
		const seen = createdAt.get(card.paperId) ?? card.publishedAt;
		return {
			id: `urn:paper-radar:paper:${card.paperId}`,
			title: card.title,
			link: card.landingUrl,
			summary: summaryOf(card, options.origin),
			authors: card.authors,
			published: seen,
			updated: seen,
			categories: card.categories
		};
	});
}

/** Gehört das Abo der Person? (Feeds je Abo) */
export async function ownsSubscription(
	db: Db,
	userId: string,
	subscriptionId: number
): Promise<boolean> {
	const [row] = await db
		.select({ id: subscriptions.id })
		.from(subscriptions)
		.where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)));
	return Boolean(row);
}

/** OPML-Einträge: Gesamtfeed plus ein Feed je Abo. */
export async function opmlOutlines(
	db: Db,
	userId: string,
	origin: string,
	token: string
): Promise<OpmlOutline[]> {
	const all = feedUrls(origin, token);
	const outlines: OpmlOutline[] = [
		{ title: 'Paper-Radar – alle Treffer', xmlUrl: all.rss, htmlUrl: all.html }
	];
	const typeLabel = { keyword: 'Stichwort', category: 'Kategorie', author: 'Autor:in' } as const;
	for (const s of await listSubscriptions(db, userId)) {
		const urls = feedUrls(origin, token, s.id);
		outlines.push({
			title: `Paper-Radar – ${typeLabel[s.type]}: ${s.query}`,
			xmlUrl: urls.rss,
			htmlUrl: urls.html
		});
	}
	return outlines;
}
