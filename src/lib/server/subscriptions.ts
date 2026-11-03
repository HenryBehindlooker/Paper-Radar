import { and, asc, eq, sql } from 'drizzle-orm';
import { ARXIV_CATEGORY_IDS } from '../arxiv-categories';
import type { Db } from './db/index';
import { createSubscription, InvalidQueryError } from './db/queries';
import { sourceQueries, subscriptions, users, verificationTokens } from './db/schema';
import type { QueryKind } from './sources/types';

/** Höchstzahl Abos pro Konto. */
export const MAX_SUBSCRIPTIONS = 50;

/** Erlaubte Gewichte („weniger“ … „viel mehr“). */
export const WEIGHTS = [0.5, 1, 2, 3] as const;

export class SubscriptionError extends Error {}

export type RequestBackfill = (sourceQueryId: number) => Promise<void>;

export interface SubscriptionView {
	id: number;
	type: QueryKind;
	query: string;
	weight: number;
	createdAt: Date;
	backfillStatus: 'pending' | 'running' | 'done' | 'failed';
	backfillFinishedAt: Date | null;
	/** Wie viele Konten dieses Query abonniert haben (nur Anzahl, keine Namen). */
	sharedWith: number;
}

const KINDS: ReadonlySet<string> = new Set(['keyword', 'category', 'author']);

export function parseSubscriptionInput(input: {
	type: unknown;
	query: unknown;
	weight?: unknown;
}): { type: QueryKind; query: string; weight: number } {
	const type = String(input.type ?? '');
	if (!KINDS.has(type)) throw new SubscriptionError('Bitte einen Abo-Typ wählen.');
	const query = String(input.query ?? '').trim();
	if (!query)
		throw new SubscriptionError(
			'Bitte einen Suchbegriff, eine Kategorie oder einen Namen angeben.'
		);
	if (query.length > 500)
		throw new SubscriptionError('Die Eingabe ist zu lang (max. 500 Zeichen).');
	if (type === 'category' && !ARXIV_CATEGORY_IDS.has(query)) {
		throw new SubscriptionError('Unbekannte arXiv-Kategorie.');
	}
	const weight = input.weight === undefined || input.weight === '' ? 1 : Number(input.weight);
	if (!(WEIGHTS as readonly number[]).includes(weight)) {
		throw new SubscriptionError('Ungültiges Gewicht.');
	}
	return { type: type as QueryKind, query, weight };
}

export async function listSubscriptions(db: Db, userId: string): Promise<SubscriptionView[]> {
	return db
		.select({
			id: subscriptions.id,
			type: subscriptions.type,
			query: subscriptions.query,
			weight: subscriptions.weight,
			createdAt: subscriptions.createdAt,
			backfillStatus: sourceQueries.backfillStatus,
			backfillFinishedAt: sourceQueries.backfillFinishedAt,
			sharedWith: sql<number>`(SELECT count(*)::int FROM subscriptions s2 WHERE s2.source_query_id = ${subscriptions.sourceQueryId})`
		})
		.from(subscriptions)
		.innerJoin(sourceQueries, eq(sourceQueries.id, subscriptions.sourceQueryId))
		.where(eq(subscriptions.userId, userId))
		.orderBy(asc(subscriptions.createdAt), asc(subscriptions.id));
}

/**
 * Legt ein Abo an. Ein Backfill wird nur eingereiht, wenn das (deduplizierte) Query
 * noch nie erfolgreich nachgeladen wurde – sonst sind die Paper schon da.
 */
export async function addSubscription(
	db: Db,
	requestBackfill: RequestBackfill,
	userId: string,
	raw: { type: unknown; query: unknown; weight?: unknown }
): Promise<{ subscriptionId: number; backfillRequested: boolean }> {
	const input = parseSubscriptionInput(raw);
	const [{ n } = { n: 0 }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(subscriptions)
		.where(eq(subscriptions.userId, userId));
	if (n >= MAX_SUBSCRIPTIONS) {
		throw new SubscriptionError(`Maximal ${MAX_SUBSCRIPTIONS} Abos pro Konto.`);
	}

	let created;
	try {
		created = await createSubscription(db, { userId, ...input });
	} catch (error) {
		if (error instanceof InvalidQueryError) throw new SubscriptionError(error.message);
		throw error;
	}

	const [sq] = await db
		.select({
			status: sourceQueries.backfillStatus,
			requestedAt: sourceQueries.backfillRequestedAt
		})
		.from(sourceQueries)
		.where(eq(sourceQueries.id, created.sourceQueryId));
	const needsBackfill =
		created.sourceQueryCreated ||
		sq?.status === 'failed' ||
		(sq?.status === 'pending' && !sq.requestedAt);
	if (needsBackfill) await requestBackfill(created.sourceQueryId);
	return { subscriptionId: created.subscriptionId, backfillRequested: needsBackfill };
}

export async function removeSubscription(db: Db, userId: string, id: number): Promise<boolean> {
	const deleted = await db
		.delete(subscriptions)
		.where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
		.returning({ id: subscriptions.id });
	return deleted.length > 0;
}

export async function updateSubscriptionWeight(
	db: Db,
	userId: string,
	id: number,
	weight: unknown
): Promise<boolean> {
	const w = Number(weight);
	if (!(WEIGHTS as readonly number[]).includes(w))
		throw new SubscriptionError('Ungültiges Gewicht.');
	const updated = await db
		.update(subscriptions)
		.set({ weight: w })
		.where(and(eq(subscriptions.id, id), eq(subscriptions.userId, userId)))
		.returning({ id: subscriptions.id });
	return updated.length > 0;
}

/**
 * Löscht das Konto mit allen personenbezogenen Daten (DSGVO): Nutzer:in, Sessions,
 * Abos, Treffer/Merkliste (per Fremdschlüssel-Kaskade) und offene Anmelde-Tokens.
 * Deduplizierte Queries ohne verbleibende Abos räumt der Cleanup-Job auf.
 */
export async function deleteAccount(db: Db, userId: string): Promise<boolean> {
	return db.transaction(async (tx) => {
		const [user] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
		if (!user) return false;
		await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, user.email));
		await tx.delete(users).where(eq(users.id, userId));
		return true;
	});
}
