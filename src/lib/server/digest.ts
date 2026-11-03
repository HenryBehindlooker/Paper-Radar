import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { formatDate } from '../papers/format';
import { explainReasons } from '../ranking/reasons';
import { APP_NAME } from './config';
import type { Db } from './db/index';
import { matches, papers, users } from './db/schema';
import type { Logger } from './log';
import { hydrateCards, type PaperCard } from './papers-view';
import { liveScoreSql } from './ranking/match';
import { signToken, verifyToken } from './tokens';

/**
 * Wochen-Mail (Opt-in): Top-10 der Treffer der letzten 7 Tage, mit Abmeldelink in jeder
 * Mail (auch als One-Click-Header nach RFC 8058). Keine Tracking-Pixel, keine
 * umgeschriebenen Links.
 */

export const DIGEST_SIZE = 10;
const DAY_MS = 86_400_000;

export function unsubscribeToken(key: Buffer, userId: string): string {
	return signToken(key, userId);
}

export function unsubscribeUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, '')}/abmelden/${encodeURIComponent(token)}`;
}

/** Meldet von der Wochen-Mail ab; `false` bei ungültigem Token oder unbekannter Person. */
export async function unsubscribeByToken(db: Db, key: Buffer, token: string): Promise<boolean> {
	const userId = verifyToken(key, token);
	if (!userId) return false;
	const updated = await db
		.update(users)
		.set({ weeklyDigest: false })
		.where(eq(users.id, userId))
		.returning({ id: users.id });
	return updated.length > 0;
}

export async function setWeeklyDigest(db: Db, userId: string, enabled: boolean): Promise<void> {
	await db.update(users).set({ weeklyDigest: enabled }).where(eq(users.id, userId));
}

/** Top-Treffer der letzten 7 Tage (nach Live-Score), ohne ausgeblendete. */
export async function weeklyTopPapers(
	db: Db,
	userId: string,
	now: Date,
	halfLifeDays: number,
	size = DIGEST_SIZE
): Promise<PaperCard[]> {
	const live = liveScoreSql(halfLifeDays, now);
	const since = new Date(now.getTime() - 7 * DAY_MS);
	const ranked = await db
		.select({ paperId: matches.paperId, score: sql<number>`${live}` })
		.from(matches)
		.innerJoin(papers, eq(papers.id, matches.paperId))
		.where(
			and(
				eq(matches.userId, userId),
				eq(matches.hidden, false),
				gte(matches.createdAt, since),
				sql`jsonb_array_length(${matches.reasons}) > 0`
			)
		)
		.orderBy(desc(live), desc(papers.publishedAt))
		.limit(size);
	return hydrateCards(
		db,
		userId,
		ranked.map((r) => ({ paperId: r.paperId, score: Number(r.score) })),
		3
	);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

export interface DigestMail {
	subject: string;
	text: string;
	html: string;
	headers: Record<string, string>;
}

export function digestMail(
	items: readonly PaperCard[],
	options: { origin: string; unsubscribeUrl: string; now: Date }
): DigestMail {
	const origin = options.origin.replace(/\/$/, '');
	const subject = `${APP_NAME}: Deine ${items.length} wichtigsten Paper der Woche`;
	const detail = (id: number) => `${origin}/paper/${id}`;
	const authorsOf = (c: PaperCard) =>
		c.authors.join(', ') + (c.authorCount > c.authors.length ? ' u. a.' : '');

	const text = [
		'Hallo,',
		'',
		`hier sind die ${items.length} wichtigsten neuen Paper zu deinen Abos aus den letzten 7 Tagen:`,
		'',
		...items.flatMap((c, i) => [
			`${i + 1}. ${c.title}`,
			`   ${[authorsOf(c), formatDate(c.publishedAt)].filter(Boolean).join(' · ')}`,
			`   Warum: ${explainReasons(c.reasons).join('; ')}`,
			`   ${detail(c.paperId)}`,
			''
		]),
		`Alle Treffer: ${origin}/`,
		'',
		'--',
		`Du bekommst diese Mail, weil du die Wochen-Mail von ${APP_NAME} eingeschaltet hast.`,
		`Abmelden: ${options.unsubscribeUrl}`,
		`Einstellungen: ${origin}/konto`
	].join('\n');

	const list = items
		.map(
			(c) => `<li style="margin-bottom:1em">
<a href="${escapeHtml(detail(c.paperId))}" style="font-weight:600;color:#1a1c20">${escapeHtml(c.title)}</a><br>
<span style="color:#5b6270;font-size:.9em">${escapeHtml([authorsOf(c), formatDate(c.publishedAt)].filter(Boolean).join(' · '))}</span><br>
<span style="color:#5b6270;font-size:.9em">Warum: ${escapeHtml(explainReasons(c.reasons).join('; '))}</span>
</li>`
		)
		.join('\n');
	const html = `<!doctype html>
<html lang="de"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1c20;max-width:40em">
<p>Hallo,</p>
<p>hier sind die ${items.length} wichtigsten neuen Paper zu deinen Abos aus den letzten 7 Tagen:</p>
<ol>
${list}
</ol>
<p><a href="${escapeHtml(origin)}/">Alle Treffer ansehen</a></p>
<hr>
<p style="font-size:.85em;color:#5b6270">Du bekommst diese Mail, weil du die Wochen-Mail von ${APP_NAME} eingeschaltet hast.
<a href="${escapeHtml(options.unsubscribeUrl)}">Abmelden</a> · <a href="${escapeHtml(origin)}/konto">Einstellungen</a></p>
</body></html>`;

	return {
		subject,
		text,
		html,
		headers: {
			'List-Unsubscribe': `<${options.unsubscribeUrl}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
		}
	};
}

export interface OutgoingMail extends DigestMail {
	to: string;
}

export interface DigestContext {
	db: Db;
	logger: Logger;
	now: () => Date;
	origin: string;
	key: Buffer;
	halfLifeDays: number;
	send: (mail: OutgoingMail) => Promise<void>;
}

export interface DigestRunResult {
	candidates: number;
	sent: number;
	skippedEmpty: number;
	failed: number;
}

/**
 * Versendet die Wochen-Mail an alle, die sie abonniert und in den letzten 6 Tagen keine
 * bekommen haben (idempotent bei Wiederholungen des Jobs). Ohne Treffer keine Mail.
 */
export async function runWeeklyDigest(ctx: DigestContext): Promise<DigestRunResult> {
	const now = ctx.now();
	const recent = new Date(now.getTime() - 6 * DAY_MS);
	const recipients = await ctx.db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(
			and(
				eq(users.weeklyDigest, true),
				or(isNull(users.lastDigestSentAt), lt(users.lastDigestSentAt, recent))
			)
		)
		.orderBy(users.id);

	const result: DigestRunResult = {
		candidates: recipients.length,
		sent: 0,
		skippedEmpty: 0,
		failed: 0
	};
	for (const r of recipients) {
		try {
			const items = await weeklyTopPapers(ctx.db, r.id, now, ctx.halfLifeDays);
			if (items.length === 0) {
				result.skippedEmpty++;
				continue;
			}
			const mail = digestMail(items, {
				origin: ctx.origin,
				unsubscribeUrl: unsubscribeUrl(ctx.origin, unsubscribeToken(ctx.key, r.id)),
				now
			});
			await ctx.send({ ...mail, to: r.email });
			await ctx.db.update(users).set({ lastDigestSentAt: now }).where(eq(users.id, r.id));
			result.sent++;
		} catch (error) {
			result.failed++;
			ctx.logger.warn('Wochen-Mail fehlgeschlagen', {
				error: error instanceof Error ? error.message : String(error)
			});
		}
	}
	ctx.logger.info('Wochen-Mail versendet', { ...result });
	return result;
}
