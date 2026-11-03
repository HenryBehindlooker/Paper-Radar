import { describe, expect, it } from 'vitest';
import {
	SourceHttpError,
	SourceNetworkError,
	SourceRateLimitedError
} from '$lib/server/sources/errors';
import { HttpClient, parseRetryAfter, redact } from '$lib/server/sources/http';
import { RateLimiter } from '$lib/server/sources/rate-limiter';
import { FakeClock, mockFetch, type MockReply } from './helpers';

function client(reply: (url: string, i: number) => MockReply, maxRetries = 3) {
	const clock = new FakeClock();
	const limiter = new RateLimiter({ name: 'arxiv', minIntervalMs: 3000, maxConcurrent: 1, clock });
	const fetch = mockFetch(reply, clock);
	const http = new HttpClient({
		source: 'arxiv',
		limiter,
		userAgent: 'Paper-Radar/test (+https://github.com/HenryBehindlooker/Paper-Radar)',
		fetch,
		clock,
		maxRetries,
		random: () => 1
	});
	return { http, fetch, clock, limiter };
}

describe('parseRetryAfter', () => {
	it('versteht Sekunden und HTTP-Daten', () => {
		expect(parseRetryAfter('120', 0)).toBe(120_000);
		const now = Date.parse('2026-11-03T12:00:00Z');
		expect(parseRetryAfter('Tue, 03 Nov 2026 12:00:30 GMT', now)).toBe(30_000);
		expect(parseRetryAfter(null, 0)).toBeUndefined();
		expect(parseRetryAfter('bald', 0)).toBeUndefined();
	});
});

describe('redact', () => {
	it('entfernt Secrets aus URLs', () => {
		expect(redact('https://x.org/w?mailto=a@b.c&rows=2&api_key=SECRET')).toBe(
			'https://x.org/w?mailto=***&rows=2&api_key=***'
		);
	});
});

describe('HttpClient', () => {
	it('setzt den eigenen User-Agent', async () => {
		const { http, fetch } = client(() => ({ body: 'ok' }));
		await http.get('https://export.arxiv.org/api/query');
		expect(fetch.calls[0]?.headers['user-agent']).toMatch(
			/Paper-Radar.*github\.com\/HenryBehindlooker\/Paper-Radar/
		);
	});

	it('gibt nicht wiederholbare Status (404) ohne Exception zurück', async () => {
		const { http, fetch } = client(() => ({ status: 404, body: 'Resource not found.' }));
		const res = await http.get('https://api.crossref.org/works/10.1/x');
		expect(res.status).toBe(404);
		expect(fetch.calls).toHaveLength(1);
	});

	it('beachtet Retry-After bei 429 und hält dabei das Quellen-Limit ein', async () => {
		const { http, fetch } = client((_, i) =>
			i === 0 ? { status: 429, headers: { 'retry-after': '10' } } : { body: 'ok' }
		);
		const res = await http.get('https://export.arxiv.org/api/query');
		expect(res.status).toBe(200);
		expect(fetch.calls).toHaveLength(2);
		const gap = (fetch.calls[1]?.at ?? 0) - (fetch.calls[0]?.at ?? 0);
		expect(gap).toBeGreaterThanOrEqual(10_000);
	});

	it('wiederholt 503 mit exponentiellem Backoff', async () => {
		const { http, fetch } = client((_, i) => (i < 2 ? { status: 503 } : { body: 'ok' }));
		await http.get('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
		const [a, b, c] = fetch.calls.map((x) => x.at);
		// random()=1 → 2 s, dann 4 s; mindestens aber 3 s Limiter-Abstand
		expect((b as number) - (a as number)).toBeGreaterThanOrEqual(3000);
		expect((c as number) - (b as number)).toBeGreaterThanOrEqual(4000);
	});

	it('wirft SourceHttpError, wenn alle Retries scheitern', async () => {
		const { http, fetch } = client(() => ({ status: 500, body: 'kaputt' }), 2);
		await expect(http.get('https://example.org')).rejects.toBeInstanceOf(SourceHttpError);
		expect(fetch.calls).toHaveLength(3);
	});

	it('wirft SourceRateLimitedError bei sehr langem Retry-After statt zu blockieren', async () => {
		const { http, fetch, limiter, clock } = client(() => ({
			status: 429,
			headers: { 'retry-after': '3600' }
		}));
		await expect(http.get('https://example.org')).rejects.toBeInstanceOf(SourceRateLimitedError);
		expect(fetch.calls).toHaveLength(1);
		// Die Quelle bleibt pausiert: der nächste Start erfolgt frühestens nach einer Stunde.
		const t0 = clock.now();
		await limiter.schedule(async () => undefined);
		expect(clock.now() - t0).toBeGreaterThanOrEqual(3_600_000);
	});

	it('wiederholt Netzwerkfehler und wirft danach SourceNetworkError', async () => {
		const clock = new FakeClock();
		const limiter = new RateLimiter({ name: 'x', minIntervalMs: 0, maxConcurrent: 1, clock });
		let calls = 0;
		const http = new HttpClient({
			source: 'europepmc',
			limiter,
			userAgent: 'test',
			clock,
			maxRetries: 2,
			fetch: async () => {
				calls++;
				throw new TypeError('fetch failed');
			}
		});
		await expect(http.get('https://example.org')).rejects.toBeInstanceOf(SourceNetworkError);
		expect(calls).toBe(3);
	});

	it('ruft onResponse für jede Antwort auf', async () => {
		const clock = new FakeClock();
		const limiter = new RateLimiter({ name: 'x', minIntervalMs: 0, maxConcurrent: 1, clock });
		const seen: number[] = [];
		const http = new HttpClient({
			source: 'crossref',
			limiter,
			userAgent: 'test',
			clock,
			fetch: mockFetch((_, i) => (i === 0 ? { status: 503 } : { body: '{}' })),
			onResponse: (r) => seen.push(r.status)
		});
		await http.get('https://api.crossref.org/works/10.1/x');
		expect(seen).toEqual([503, 200]);
	});
});
