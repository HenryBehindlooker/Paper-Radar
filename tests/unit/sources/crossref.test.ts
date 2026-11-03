import { describe, expect, it } from 'vitest';
import {
	applyCrossrefRateHeaders,
	crossrefAbstractLicenseOk,
	CrossrefSource,
	encodeDoiPath,
	normalizeCrossrefWork,
	type CrossrefWork
} from '$lib/server/sources/crossref';
import { SourceHttpError } from '$lib/server/sources/errors';
import { HttpClient } from '$lib/server/sources/http';
import { RateLimiter } from '$lib/server/sources/rate-limiter';
import { FakeClock, fixture, mockFetch, type MockReply } from './helpers';

const now = new Date('2026-11-03T12:00:00Z');
const work = (path: string) => (JSON.parse(fixture(path)) as { message: CrossrefWork }).message;

function source(reply: (url: string, i: number) => MockReply, mailto?: string) {
	const clock = new FakeClock();
	const limiter = new RateLimiter({
		name: 'crossref',
		minIntervalMs: 200,
		maxConcurrent: 1,
		clock
	});
	const fetch = mockFetch(reply, clock);
	const http = new HttpClient({
		source: 'crossref',
		limiter,
		userAgent: 'test',
		fetch,
		clock,
		onResponse: (r) => applyCrossrefRateHeaders(limiter, r)
	});
	return {
		crossref: new CrossrefSource({ http, now: () => now, ...(mailto ? { mailto } : {}) }),
		fetch,
		limiter
	};
}

describe('normalizeCrossrefWork', () => {
	it('übernimmt CC-BY-Abstracts ohne JATS-Markup', () => {
		const p = normalizeCrossrefWork(work('crossref/work-cc-by.json'), now);
		expect(p).toMatchObject({
			source: 'crossref',
			ids: { doi: '10.1002/advs.78445' },
			title:
				'Phosphate‐Engineered DNA Reporters Boost CRISPR‐Cas12a Trans ‐Cleavage for Rapid and Sensitive Nucleic Acid Detection',
			abstractLicenseOk: true,
			landingUrl: 'https://doi.org/10.1002/advs.78445'
		});
		expect(p?.abstract).toMatch(/^CRISPR–Cas12a molecular diagnostics/);
		expect(p?.abstract).not.toMatch(/jats|<|ABSTRACT/);
		expect(p?.authors[0]).toEqual({ name: 'Rui Yang', orcid: '0009-0003-5839-1059' });
		expect(p?.publishedAt.toISOString()).toBe('2026-10-25T00:00:00.000Z');
		expect(p?.pdfUrl).toBeUndefined();
	});

	it('verwirft Abstracts unter Verlagslizenz (Wiley-AGB)', () => {
		const raw = work('crossref/work-abstract-publisher-license.json');
		expect(raw.abstract).toBeTruthy();
		const p = normalizeCrossrefWork(raw, now);
		expect(p?.abstract).toBeUndefined();
		expect(p?.abstractLicenseOk).toBe(false);
	});

	it('verwirft Abstracts ganz ohne Lizenzangabe (ACM)', () => {
		const p = normalizeCrossrefWork(work('crossref/work-abstract-no-license.json'), now);
		expect(p?.abstract).toBeUndefined();
		expect(p?.abstractLicenseOk).toBe(false);
		expect(p?.authors[0]?.orcid).toBe('0009-0007-8870-2662');
	});

	it('Datensätze ohne Abstract (Springer, 1999) mit Teildatum', () => {
		const p = normalizeCrossrefWork(work('crossref/work-maldacena-1998.json'), now);
		expect(p?.ids.doi).toBe('10.1023/a:1026654312961');
		expect(p?.abstract).toBeUndefined();
		expect(p?.publishedAt.toISOString()).toBe('1999-04-01T00:00:00.000Z');
		expect(p?.journal).toBeTruthy();
	});

	it('posted-content (Preprint) nutzt das posted-Datum', () => {
		const p = normalizeCrossrefWork(work('crossref/work-posted-content.json'), now);
		expect(p?.publishedAt.toISOString()).toBe('2026-10-29T00:00:00.000Z');
		expect(p?.title).toBe(
			'Establishing a blood-stage controlled human malaria infection model with Plasmodium falciparum in healthy semi-immune Tanzanian adults'
		);
		expect(p?.abstractLicenseOk).toBe(true);
	});

	it('Pflichtfelder fehlen → null', () => {
		expect(normalizeCrossrefWork({ DOI: '10.1/x' }, now)).toBeNull();
		expect(
			normalizeCrossrefWork({ title: ['T'], issued: { 'date-parts': [[2020]] } }, now)
		).toBeNull();
	});
});

describe('crossrefAbstractLicenseOk', () => {
	const cc = 'http://creativecommons.org/licenses/by/4.0/';
	it('berücksichtigt Version, Startdatum und Embargo', () => {
		const at = (iso: string, extra: object = {}) => ({
			license: [{ URL: cc, 'content-version': 'vor', start: { 'date-time': iso }, ...extra }]
		});
		expect(crossrefAbstractLicenseOk(at('2026-01-01T00:00:00Z'), now)).toBe(true);
		expect(crossrefAbstractLicenseOk(at('2027-01-01T00:00:00Z'), now)).toBe(false);
		expect(
			crossrefAbstractLicenseOk(at('2026-11-01T00:00:00Z', { 'delay-in-days': 30 }), now)
		).toBe(false);
		expect(
			crossrefAbstractLicenseOk(
				{
					license: [
						{ URL: cc, 'content-version': 'am', start: { 'date-time': '2020-01-01T00:00:00Z' } }
					]
				},
				now
			)
		).toBe(false);
		expect(crossrefAbstractLicenseOk({ license: [{ URL: cc }] }, now)).toBe(true);
		expect(crossrefAbstractLicenseOk({}, now)).toBe(false);
	});
});

describe('CrossrefSource', () => {
	it('getById: DOI im Pfad, mailto nur wenn konfiguriert', async () => {
		const { crossref, fetch } = source(
			() => ({ body: fixture('crossref/work-cc-by.json') }),
			'ops@example.org'
		);
		const [p] = await crossref.getById({
			type: 'doi',
			value: 'https://doi.org/10.1002/ADVS.78445'
		});
		expect(p?.ids.doi).toBe('10.1002/advs.78445');
		expect(fetch.calls[0]?.url).toBe(
			'https://api.crossref.org/works/10.1002/advs.78445?mailto=ops%40example.org'
		);

		const anon = source(() => ({ body: fixture('crossref/work-cc-by.json') }));
		await anon.crossref.getById({ type: 'doi', value: '10.1002/advs.78445' });
		expect(anon.fetch.calls[0]?.url).toBe('https://api.crossref.org/works/10.1002/advs.78445');
	});

	it('404 („Resource not found.“) → leere Liste; DataCite-DOIs ebenso', async () => {
		const { crossref } = source(() => ({
			status: 404,
			body: fixture('crossref/work-not-found.txt')
		}));
		expect(
			await crossref.getById({ type: 'doi', value: '10.1234/paper-radar-does-not-exist' })
		).toEqual([]);
		expect(await crossref.getById({ type: 'doi', value: '10.48550/arXiv.1706.03762' })).toEqual([]);
		expect(await crossref.getById({ type: 'arxiv', value: '1706.03762' })).toEqual([]);
	});

	it('getByDois bündelt per Filter', async () => {
		const { crossref, fetch } = source(() => ({
			body: fixture('crossref/works-filter-dois.json')
		}));
		const papers = await crossref.getByDois([
			'10.1002/advs.78445',
			'https://doi.org/10.1145/3859365',
			'10.1002/ADVS.78445',
			'keine-doi'
		]);
		expect(fetch.calls).toHaveLength(1);
		expect(new URL(fetch.calls[0]?.url ?? '').searchParams.get('filter')).toBe(
			'doi:10.1002/advs.78445,doi:10.1145/3859365'
		);
		expect(papers.map((p) => p.ids.doi).sort()).toEqual(['10.1002/advs.78445', '10.1145/3859365']);
	});

	it('übernimmt die Limits aus den Antwort-Headern (Listen: 1 req/s)', async () => {
		const { crossref, fetch, limiter } = source(() => ({
			body: fixture('crossref/works-filter-dois.json'),
			headers: {
				'x-rate-limit-limit': '1',
				'x-rate-limit-interval': '1s',
				'x-concurrency-limit': '1'
			}
		}));
		const dois = Array.from({ length: 45 }, (_, i) => `10.1000/test.${i}`);
		await crossref.getByDois(dois);
		expect(fetch.calls).toHaveLength(3);
		expect(limiter.minIntervalMs).toBe(1000);
		const gaps = fetch.calls.slice(1).map((c, i) => c.at - (fetch.calls[i]?.at ?? 0));
		for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1000);
	});

	it('wirft bei unerwarteten Status', async () => {
		const { crossref } = source(() => ({ status: 400, body: 'bad' }));
		await expect(crossref.getById({ type: 'doi', value: '10.1000/x' })).rejects.toBeInstanceOf(
			SourceHttpError
		);
	});

	it('kodiert Sonderzeichen in DOIs, behält aber /', () => {
		expect(encodeDoiPath('10.1002/(sici)1097-4636(199706)35:4<425::aid-jbm3>3.0.co;2-k')).toBe(
			'10.1002/(sici)1097-4636(199706)35%3A4%3C425%3A%3Aaid-jbm3%3E3.0.co%3B2-k'
		);
	});

	it('search ist bewusst nicht unterstützt', async () => {
		const { crossref, fetch } = source(() => ({ body: '' }));
		expect(crossref.supportedQueryKinds.size).toBe(0);
		expect(await crossref.search()).toEqual([]);
		expect(fetch.calls).toHaveLength(0);
	});
});
