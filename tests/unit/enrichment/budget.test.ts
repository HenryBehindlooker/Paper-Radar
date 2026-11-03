import { describe, expect, it } from 'vitest';
import {
	checkBudget,
	DEFAULT_OPENALEX_BUDGET,
	loadOpenAlexBudget,
	nextUtcMidnight,
	OpenAlexUsageTracker,
	utcDay
} from '$lib/server/enrichment/budget';

describe('OpenAlex-Budget', () => {
	it('liest die Konfiguration aus der Umgebung', () => {
		expect(loadOpenAlexBudget({})).toEqual(DEFAULT_OPENALEX_BUDGET);
		expect(
			loadOpenAlexBudget({
				OPENALEX_DAILY_CREDIT_BUDGET: '50',
				OPENALEX_DAILY_REQUEST_LIMIT: '0',
				OPENALEX_MIN_RELEVANCE: '0.8'
			})
		).toMatchObject({ dailyCredits: 50, dailyRequests: 0, minRelevance: 0.8 });
		expect(
			loadOpenAlexBudget({
				OPENALEX_DAILY_CREDIT_BUDGET: 'viel',
				OPENALEX_DAILY_REQUEST_LIMIT: '-3'
			})
		).toMatchObject({
			dailyCredits: DEFAULT_OPENALEX_BUDGET.dailyCredits,
			dailyRequests: DEFAULT_OPENALEX_BUDGET.dailyRequests
		});
	});

	it('entscheidet, ob ein weiterer Request erlaubt ist', () => {
		const config = {
			...DEFAULT_OPENALEX_BUDGET,
			dailyCredits: 10,
			dailyRequests: 5,
			minRemaining: 20
		};
		expect(checkBudget({ requests: 0, credits: 0, lastRemaining: null }, config)).toEqual({
			ok: true
		});
		expect(checkBudget({ requests: 4, credits: 9, lastRemaining: 20 }, config)).toEqual({
			ok: true
		});
		expect(checkBudget({ requests: 1, credits: 10, lastRemaining: null }, config)).toEqual({
			ok: false,
			reason: 'credits'
		});
		expect(checkBudget({ requests: 5, credits: 0, lastRemaining: null }, config)).toEqual({
			ok: false,
			reason: 'requests'
		});
		expect(checkBudget({ requests: 0, credits: 0, lastRemaining: 19 }, config)).toEqual({
			ok: false,
			reason: 'remaining'
		});
		// Budget 0 schaltet die Anreicherung praktisch ab.
		expect(
			checkBudget({ requests: 0, credits: 0, lastRemaining: null }, { ...config, dailyRequests: 0 })
				.ok
		).toBe(false);
	});

	it('UTC-Tag und nächster Reset', () => {
		expect(utcDay(new Date('2026-11-08T23:59:59Z'))).toBe('2026-11-08');
		expect(nextUtcMidnight(new Date('2026-11-08T23:59:59Z')).toISOString()).toBe(
			'2026-11-09T00:00:00.000Z'
		);
		expect(nextUtcMidnight(new Date('2026-12-31T05:00:00Z')).toISOString()).toBe(
			'2027-01-01T00:00:00.000Z'
		);
	});

	it('Tracker sammelt Verbrauch je UTC-Tag', () => {
		let now = new Date('2026-11-08T23:59:00Z');
		const tracker = new OpenAlexUsageTracker(() => now);
		tracker.record({ creditsUsed: 0, remaining: 9999, status: 200 });
		tracker.record({ creditsUsed: 2, status: 200 });
		expect(tracker.pending('2026-11-08')).toEqual({ requests: 2, credits: 2, lastRemaining: 9999 });
		now = new Date('2026-11-09T00:01:00Z');
		tracker.record({ creditsUsed: 1, remaining: 10, status: 429 });
		expect(tracker.drain()).toEqual([
			['2026-11-08', { requests: 2, credits: 2, lastRemaining: 9999 }],
			['2026-11-09', { requests: 1, credits: 1, lastRemaining: 10 }]
		]);
		expect(tracker.drain()).toEqual([]);
		expect(tracker.pending('2026-11-09')).toEqual({ requests: 0, credits: 0, lastRemaining: null });
	});
});
