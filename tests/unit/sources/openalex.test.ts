import { describe, expect, it } from 'vitest';
import {
	SourceBudgetExhaustedError,
	SourceDisabledError,
	SourceHttpError
} from '$lib/server/sources/errors';
import { HttpClient } from '$lib/server/sources/http';
import {
	createOpenAlexResponseHook,
	normalizeOpenAlexWork,
	OpenAlexSource,
	type OpenAlexUsage,
	type OpenAlexWork
} from '$lib/server/sources/openalex';
import { RateLimiter } from '$lib/server/sources/rate-limiter';
import { FakeClock, fixture, mockFetch, type MockReply } from './helpers';

const USAGE_HEADERS = {
	'x-ratelimit-credits-used': '0',
	'x-ratelimit-limit': '10000',
	'x-ratelimit-remaining': '9998',
	'x-ratelimit-reset': '38082'
};

function source(reply: (url: string, i: number) => MockReply, apiKey: string | null = 'KEY123') {
	const clock = new FakeClock();
	const limiter = new RateLimiter({
		name: 'openalex',
		minIntervalMs: 100,
		maxConcurrent: 1,
		clock
	});
	const fetch = mockFetch(reply, clock);
	const usage: OpenAlexUsage[] = [];
	const http = new HttpClient({
		source: 'openalex',
		limiter,
		userAgent: 'test',
		fetch,
		clock,
		maxRetries: 1,
		onResponse: createOpenAlexResponseHook((u) => usage.push(u))
	});
	return {
		openalex: new OpenAlexSource({ http, ...(apiKey ? { apiKey } : {}) }),
		fetch,
		usage
	};
}

describe('normalizeOpenAlexWork', () => {
	it('liest Zitationszahl, IDs und Autoren (auch ohne Autor-ID)', () => {
		const work = JSON.parse(fixture('openalex/work-by-doi.json')) as OpenAlexWork;
		const p = normalizeOpenAlexWork(work);
		expect(p).toMatchObject({
			source: 'openalex',
			ids: { openalexId: 'W2166248051', doi: '10.1023/a:1026654312961' },
			title: 'The Large-N Limit of Superconformal Field Theories and Supergravity',
			citedByCount: 6821,
			abstractLicenseOk: false,
			authors: [{ name: 'Juan Maldacena' }],
			landingUrl: 'https://doi.org/10.1023/a:1026654312961'
		});
		expect(p?.abstract).toBeUndefined();
		expect(p?.publishedAt.toISOString()).toBe('1999-04-01T00:00:00.000Z');
	});

	it('übernimmt PMID/PMCID und Autoren-IDs aus dem Volldatensatz, aber keinen Abstract', () => {
		const work = JSON.parse(fixture('openalex/work-by-doi-full.json')) as OpenAlexWork & {
			abstract_inverted_index?: unknown;
		};
		expect(work.abstract_inverted_index).toBeTruthy();
		const p = normalizeOpenAlexWork(work);
		expect(p?.ids).toEqual({
			openalexId: 'W7223565498',
			doi: '10.1002/advs.78445',
			pmid: '42928415',
			pmcid: 'PMC13696524'
		});
		expect(p?.abstract).toBeUndefined();
		expect(p?.authors.some((a) => a.openalexId?.startsWith('A'))).toBe(true);
		expect(p?.authors.some((a) => a.orcid === '0009-0003-5839-1059')).toBe(true);
	});

	it('Pflichtfelder fehlen → null', () => {
		expect(normalizeOpenAlexWork({ id: 'https://openalex.org/W1' })).toBeNull();
	});
});

describe('OpenAlexSource', () => {
	it('ist ohne API-Key deaktiviert und macht keinen Request', async () => {
		const { openalex, fetch } = source(() => ({ body: '{}' }), null);
		expect(openalex.enabled).toBe(false);
		await expect(openalex.getById({ type: 'doi', value: '10.1000/x' })).rejects.toBeInstanceOf(
			SourceDisabledError
		);
		expect(fetch.calls).toHaveLength(0);
	});

	it('Einzelabruf per DOI: Key nur im Header, nie in der URL; Credits werden protokolliert', async () => {
		const { openalex, fetch, usage } = source(() => ({
			body: fixture('openalex/work-by-doi.json'),
			headers: USAGE_HEADERS
		}));
		const [p] = await openalex.getById({ type: 'doi', value: '10.1023/A:1026654312961' });
		expect(p?.citedByCount).toBe(6821);
		const call = fetch.calls[0];
		expect(call?.url).toMatch(
			/^https:\/\/api\.openalex\.org\/works\/doi:10\.1023\/a%3A1026654312961\?select=/
		);
		expect(call?.url).not.toContain('KEY123');
		expect(call?.headers.authorization).toBe('Bearer KEY123');
		expect(usage).toEqual([
			{ creditsUsed: 0, limit: 10000, remaining: 9998, resetSeconds: 38082, status: 200 }
		]);
	});

	it('404 (HTML-Antwort) → leere Liste', async () => {
		const { openalex } = source(() => ({
			status: 404,
			body: fixture('openalex/work-not-found.html')
		}));
		expect(await openalex.getById({ type: 'doi', value: '10.1234/nope' })).toEqual([]);
	});

	it('unterstützt W-IDs und PMID; andere ID-Typen ohne Request', async () => {
		const { openalex, fetch } = source(() => ({ body: fixture('openalex/work-by-doi.json') }));
		await openalex.getById({ type: 'openalex', value: 'https://openalex.org/W2166248051' });
		await openalex.getById({ type: 'pmid', value: '42928415' });
		expect(await openalex.getById({ type: 'arxiv', value: '2103.00020' })).toEqual([]);
		expect(fetch.calls.map((c) => new URL(c.url).pathname)).toEqual([
			'/works/W2166248051',
			'/works/pmid:42928415'
		]);
	});

	it('pausiert sauber bei erschöpftem Budget statt zu wiederholen', async () => {
		const { openalex, fetch } = source(() => ({
			status: 429,
			body: '{"error":"not_enough_credits"}',
			headers: { ...USAGE_HEADERS, 'x-ratelimit-remaining': '0' }
		}));
		await expect(openalex.getById({ type: 'doi', value: '10.1000/x' })).rejects.toBeInstanceOf(
			SourceBudgetExhaustedError
		);
		expect(fetch.calls).toHaveLength(1);
	});

	it('wiederholt kurzfristige 429 (Budget noch vorhanden)', async () => {
		const { openalex, fetch } = source((_, i) =>
			i === 0
				? { status: 429, headers: { ...USAGE_HEADERS, 'retry-after': '1' } }
				: { body: fixture('openalex/work-by-doi.json'), headers: USAGE_HEADERS }
		);
		const result = await openalex.getById({ type: 'doi', value: '10.1023/a:1026654312961' });
		expect(result).toHaveLength(1);
		expect(fetch.calls).toHaveLength(2);
	});

	it('wirft bei 400', async () => {
		const { openalex } = source(() => ({ status: 400, body: '{"error":"Invalid"}' }));
		await expect(openalex.getById({ type: 'doi', value: '10.1000/x' })).rejects.toBeInstanceOf(
			SourceHttpError
		);
	});

	it('bietet keine (credit-pflichtige) Suche an', async () => {
		const { openalex, fetch } = source(() => ({ body: '' }));
		expect(await openalex.search()).toEqual([]);
		expect(fetch.calls).toHaveLength(0);
	});
});
