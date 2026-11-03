import type { MatchReason, MatchReasonType } from '../../ranking/reasons';

/**
 * Ranking als reine Funktionen.
 *
 *   score = ( Textrelevanz × Abo-Gewicht
 *           + Autor-Boost × Abo-Gewicht
 *           + Kategorie-Boost × Abo-Gewicht ) × Aktualitäts-Abfall
 *
 * - Textrelevanz: ts_rank_cd des besten Stichwort-Abos, normiert auf [0, 1) mit r/(r+1)
 *   (entspricht Postgres-Normalisierung 32). Mehrere Stichwort-Abos zählen nicht doppelt:
 *   es zählt das stärkste.
 * - Boosts: fester Bonus, wenn mindestens ein Autor- bzw. Kategorie-Abo trifft
 *   (jeweils mit dem höchsten Gewicht unter den Treffern dieser Art).
 * - Aktualitäts-Abfall: 0,5^(Alter / Halbwertszeit); Standard-Halbwertszeit 7 Tage.
 */

export interface RankingConfig {
	halfLifeDays: number;
	authorBoost: number;
	categoryBoost: number;
}

export const DEFAULT_RANKING: RankingConfig = {
	halfLifeDays: 7,
	authorBoost: 0.6,
	categoryBoost: 0.3
};

export function loadRankingConfig(env: Record<string, string | undefined>): RankingConfig {
	const halfLife = Number(env.RANKING_HALF_LIFE_DAYS);
	return {
		...DEFAULT_RANKING,
		halfLifeDays:
			Number.isFinite(halfLife) && halfLife > 0 ? halfLife : DEFAULT_RANKING.halfLifeDays
	};
}

/** ts_rank_cd ∈ [0, ∞) → [0, 1). */
export function normalizeTextRank(raw: number): number {
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	return raw / (raw + 1);
}

const DAY_MS = 86_400_000;

/** 1 für heute (und Zukunft), 0,5 nach einer Halbwertszeit usw. */
export function recencyDecay(publishedAt: Date, now: Date, halfLifeDays: number): number {
	const ageDays = Math.max(0, (now.getTime() - publishedAt.getTime()) / DAY_MS);
	return 0.5 ** (ageDays / halfLifeDays);
}

/** Ein Abo, das ein Paper trifft. */
export interface SubscriptionHit {
	subscriptionId: number;
	type: MatchReasonType;
	query: string;
	weight: number;
	/** Nur Stichwort: rohes ts_rank_cd. */
	textRank?: number;
	/** Nur Stichwort: Treffer im Titel? */
	inTitle?: boolean;
}

export interface ScoredMatch {
	/** Inklusive Aktualitäts-Abfall zum Zeitpunkt `now`. */
	score: number;
	/** Ohne Aktualitäts-Abfall (für Live-Sortierung im Feed). */
	relevance: number;
	reasons: MatchReason[];
	subscriptionIds: number[];
}

function contributionOf(hit: SubscriptionHit, config: RankingConfig): number {
	switch (hit.type) {
		case 'keyword':
			return normalizeTextRank(hit.textRank ?? 0) * hit.weight;
		case 'author':
			return config.authorBoost * hit.weight;
		case 'category':
			return config.categoryBoost * hit.weight;
	}
}

/**
 * Bewertet ein Paper für eine Person aus allen ihren Abo-Treffern.
 * Mehrfache Treffer desselben Abos werden zusammengefasst; pro Art zählt der stärkste.
 */
export function scoreMatch(
	hits: readonly SubscriptionHit[],
	publishedAt: Date,
	now: Date,
	config: RankingConfig = DEFAULT_RANKING
): ScoredMatch | null {
	if (hits.length === 0) return null;

	const bySubscription = new Map<number, SubscriptionHit>();
	for (const hit of hits) {
		const prev = bySubscription.get(hit.subscriptionId);
		if (!prev || (hit.textRank ?? 0) > (prev.textRank ?? 0))
			bySubscription.set(hit.subscriptionId, hit);
	}
	const unique = [...bySubscription.values()];

	const best: Partial<Record<MatchReasonType, number>> = {};
	const reasons: MatchReason[] = unique.map((hit) => {
		const contribution = contributionOf(hit, config);
		best[hit.type] = Math.max(best[hit.type] ?? 0, contribution);
		return {
			subscriptionId: hit.subscriptionId,
			type: hit.type,
			query: hit.query,
			weight: hit.weight,
			contribution: round(contribution),
			...(hit.type === 'keyword' ? { inTitle: hit.inTitle ?? false } : {})
		};
	});

	const base = (best.keyword ?? 0) + (best.author ?? 0) + (best.category ?? 0);
	const score = base * recencyDecay(publishedAt, now, config.halfLifeDays);
	reasons.sort((a, b) => b.contribution - a.contribution || a.subscriptionId - b.subscriptionId);
	return {
		score: round(score),
		relevance: round(base),
		reasons,
		subscriptionIds: unique.map((h) => h.subscriptionId).sort((a, b) => a - b)
	};
}

function round(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/**
 * Normalisierte Namensvarianten für Autor-Abos ohne ORCID:
 * „rui yang“ → [„rui yang“, „r yang“] (manche Quellen kürzen Vornamen ab).
 */
export function authorNameVariants(normalizedName: string): string[] {
	const parts = normalizedName.split(' ').filter(Boolean);
	const variants = [parts.join(' ')];
	if (parts.length >= 2) {
		const last = parts[parts.length - 1] as string;
		const initials = parts.slice(0, -1).map((p) => p.charAt(0));
		variants.push([...initials, last].join(' '));
		variants.push([initials[0], last].join(' '));
	}
	return [...new Set(variants.filter(Boolean))];
}
