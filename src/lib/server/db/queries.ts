import { and, eq, sql } from 'drizzle-orm';
import { isArxivCategory } from '../sources/arxiv';
import { collapseWhitespace, normalizeOrcid } from '../sources/normalize';
import type { QueryKind } from '../sources/types';
import { parseWebsearch } from '../sources/websearch';
import type { DbOrTx } from './index';
import { sourceQueries, subscriptions } from './schema';

export class InvalidQueryError extends Error {}

/**
 * Normalisierte Form eines Abo-Queries – Schlüssel für die Zusammenfassung
 * gleicher Anfragen mehrerer Nutzer:innen.
 *  - keyword: Leerraum zusammengefasst, kleingeschrieben (Suche ist case-insensitiv)
 *  - category: unverändert (arXiv-Kategorien sind case-sensitiv, z. B. `cs.DL`)
 *  - author: ORCID normalisiert; sonst „Vorname Nachname“ kleingeschrieben
 */
export function normalizeQuery(type: QueryKind, raw: string): string {
	const value = collapseWhitespace(raw);
	switch (type) {
		case 'keyword': {
			const q = value.toLowerCase();
			const hasPositive = parseWebsearch(q).some((g) => g.some((t) => !t.negated));
			if (!hasPositive)
				throw new InvalidQueryError('Das Stichwort-Abo braucht mindestens einen Suchbegriff.');
			if (q.length > 500)
				throw new InvalidQueryError('Das Stichwort-Abo ist zu lang (max. 500 Zeichen).');
			return q;
		}
		case 'category':
			if (!isArxivCategory(value))
				throw new InvalidQueryError(`Unbekanntes Kategorie-Format: ${value}`);
			return value;
		case 'author': {
			const orcid = normalizeOrcid(value);
			if (orcid) return orcid;
			const m = /^([^,]+),\s*(.+)$/.exec(value);
			const name = (m ? `${m[2]} ${m[1]}` : value).toLowerCase();
			if (name.length < 2)
				throw new InvalidQueryError('Bitte einen Namen oder eine ORCID angeben.');
			if (name.length > 200) throw new InvalidQueryError('Der Name ist zu lang.');
			return name;
		}
	}
}

/** Findet oder legt das deduplizierte Query an. */
export async function ensureSourceQuery(
	db: DbOrTx,
	type: QueryKind,
	raw: string
): Promise<{ id: number; created: boolean }> {
	const query = normalizeQuery(type, raw);
	const [inserted] = await db
		.insert(sourceQueries)
		.values({ type, query })
		.onConflictDoNothing()
		.returning({ id: sourceQueries.id });
	if (inserted) return { id: inserted.id, created: true };
	const [existing] = await db
		.select({ id: sourceQueries.id })
		.from(sourceQueries)
		.where(and(eq(sourceQueries.type, type), eq(sourceQueries.query, query)));
	if (!existing) throw new Error('source_query konnte nicht angelegt werden');
	return { id: existing.id, created: false };
}

/**
 * Legt ein Abo an (idempotent pro Nutzer:in und Query). Löst selbst keinen
 * Upstream-Request aus – der Aufrufer reiht ggf. einen Backfill-Job ein.
 */
export async function createSubscription(
	db: DbOrTx,
	input: { userId: string; type: QueryKind; query: string; weight?: number }
): Promise<{ subscriptionId: number; sourceQueryId: number; sourceQueryCreated: boolean }> {
	const sq = await ensureSourceQuery(db, input.type, input.query);
	const weight = Math.min(5, Math.max(0.1, input.weight ?? 1));
	const [row] = await db
		.insert(subscriptions)
		.values({
			userId: input.userId,
			type: input.type,
			query: collapseWhitespace(input.query),
			weight,
			sourceQueryId: sq.id
		})
		.onConflictDoUpdate({
			target: [subscriptions.userId, subscriptions.sourceQueryId],
			set: { weight, query: collapseWhitespace(input.query) }
		})
		.returning({ id: subscriptions.id });
	return {
		subscriptionId: (row as { id: number }).id,
		sourceQueryId: sq.id,
		sourceQueryCreated: sq.created
	};
}

/** Queries mit mindestens einem Abo. */
export async function activeSourceQueries(db: DbOrTx, type?: QueryKind) {
	return db
		.select()
		.from(sourceQueries)
		.where(
			and(
				sql`EXISTS (SELECT 1 FROM subscriptions s WHERE s.source_query_id = ${sourceQueries.id})`,
				type ? eq(sourceQueries.type, type) : undefined
			)
		)
		.orderBy(sourceQueries.id);
}
