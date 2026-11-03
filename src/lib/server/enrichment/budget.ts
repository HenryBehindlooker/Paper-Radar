import type { OpenAlexUsage } from '../sources/openalex';

/**
 * Budget für OpenAlex. Laut Doku sind Einzelabrufe kostenlos (0 Credits); das
 * Credit-Budget greift daher vor allem, falls sich das Preismodell ändert. Zusätzlich
 * begrenzt ein Request-Budget die Zahl der Abrufe pro Tag (Rücksicht auf den Dienst).
 * Beides gilt je UTC-Tag – OpenAlex setzt Budgets um Mitternacht UTC zurück.
 */

export interface OpenAlexBudgetConfig {
	/** Credits pro UTC-Tag (OPENALEX_DAILY_CREDIT_BUDGET). */
	dailyCredits: number;
	/** Requests pro UTC-Tag (OPENALEX_DAILY_REQUEST_LIMIT). */
	dailyRequests: number;
	/** Pausieren, wenn OpenAlex weniger Restbudget meldet (X-RateLimit-Remaining). */
	minRemaining: number;
	/** „Gut gerankt“ ab dieser Relevanz (OPENALEX_MIN_RELEVANCE). */
	minRelevance: number;
	/** Nach so vielen Tagen erneut abrufen. */
	refreshDays: number;
}

export const DEFAULT_OPENALEX_BUDGET: OpenAlexBudgetConfig = {
	dailyCredits: 1000,
	dailyRequests: 2000,
	minRemaining: 50,
	minRelevance: 0.4,
	refreshDays: 6
};

function positive(value: string | undefined, fallback: number, allowZero = false): number {
	const n = Number(value);
	if (value === undefined || value.trim() === '' || !Number.isFinite(n)) return fallback;
	return n > 0 || (allowZero && n === 0) ? n : fallback;
}

export function loadOpenAlexBudget(env: Record<string, string | undefined>): OpenAlexBudgetConfig {
	return {
		...DEFAULT_OPENALEX_BUDGET,
		dailyCredits: positive(
			env.OPENALEX_DAILY_CREDIT_BUDGET,
			DEFAULT_OPENALEX_BUDGET.dailyCredits,
			true
		),
		dailyRequests: positive(
			env.OPENALEX_DAILY_REQUEST_LIMIT,
			DEFAULT_OPENALEX_BUDGET.dailyRequests,
			true
		),
		minRelevance: positive(env.OPENALEX_MIN_RELEVANCE, DEFAULT_OPENALEX_BUDGET.minRelevance)
	};
}

export function utcDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** Nächste Mitternacht UTC (Budget-Reset). */
export function nextUtcMidnight(date: Date): Date {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

export interface DayUsage {
	requests: number;
	credits: number;
	lastRemaining: number | null;
}

export type BudgetDecision =
	{ ok: true } | { ok: false; reason: 'credits' | 'requests' | 'remaining' };

/** Darf ein weiterer Request gestellt werden? */
export function checkBudget(usage: DayUsage, config: OpenAlexBudgetConfig): BudgetDecision {
	if (usage.credits >= config.dailyCredits) return { ok: false, reason: 'credits' };
	if (usage.requests >= config.dailyRequests) return { ok: false, reason: 'requests' };
	if (usage.lastRemaining !== null && usage.lastRemaining < config.minRemaining) {
		return { ok: false, reason: 'remaining' };
	}
	return { ok: true };
}

/**
 * Sammelt Verbrauchsmeldungen aus den Antwort-Headern (synchroner Hook des HttpClient)
 * je UTC-Tag; der Job schreibt sie gesammelt in die Datenbank.
 */
export class OpenAlexUsageTracker {
	readonly #pending = new Map<string, DayUsage>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	record(usage: OpenAlexUsage): void {
		const day = utcDay(this.now());
		const current = this.#pending.get(day) ?? { requests: 0, credits: 0, lastRemaining: null };
		current.requests += 1;
		current.credits += Math.max(0, usage.creditsUsed);
		if (usage.remaining !== undefined) current.lastRemaining = usage.remaining;
		this.#pending.set(day, current);
	}

	/** Noch nicht gespeicherter Verbrauch eines Tages. */
	pending(day: string): DayUsage {
		return this.#pending.get(day) ?? { requests: 0, credits: 0, lastRemaining: null };
	}

	/** Entnimmt alle gesammelten Werte (zum Speichern). */
	drain(): Array<[string, DayUsage]> {
		const entries = [...this.#pending.entries()];
		this.#pending.clear();
		return entries;
	}
}
