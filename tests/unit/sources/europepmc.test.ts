import { describe, expect, it } from 'vitest';
import { SourceHttpError, SourceParseError } from '$lib/server/sources/errors';
import {
	buildEuropePmcQuery,
	EuropePmcSource,
	isOpenLicense,
	normalizeEuropePmcResult,
	parseEuropePmcSearch,
	toEpmcAuthorName
} from '$lib/server/sources/europepmc';
import { HttpClient } from '$lib/server/sources/http';
import { RateLimiter } from '$lib/server/sources/rate-limiter';
import { FakeClock, fixture, mockFetch, type MockReply } from './helpers';

const since = new Date('2026-10-20T00:00:00Z');
const until = new Date('2026-10-27T12:00:00Z');

function source(reply: (url: string, i: number) => MockReply, pageSize?: number) {
	const clock = new FakeClock();
	const limiter = new RateLimiter({
		name: 'europepmc',
		minIntervalMs: 200,
		maxConcurrent: 1,
		clock
	});
	const fetch = mockFetch(reply, clock);
	const http = new HttpClient({
		source: 'europepmc',
		limiter,
		userAgent: 'test',
		fetch,
		clock,
		maxRetries: 1,
		random: () => 1
	});
	return {
		epmc: new EuropePmcSource({ http, now: () => until, ...(pageSize ? { pageSize } : {}) }),
		fetch
	};
}

describe('parseEuropePmcSearch', () => {
	it('normalisiert MED-Treffer mit Lizenz, ORCID und PMCID', () => {
		const { papers, hitCount, nextCursorMark } = parseEuropePmcSearch(
			fixture('europepmc/search-crispr-core.json')
		);
		expect(papers).toHaveLength(5);
		expect(hitCount).toBeGreaterThan(5);
		expect(nextCursorMark).toBeTruthy();

		const first = papers[0];
		expect(first).toMatchObject({
			source: 'europepmc',
			ids: {
				europepmcId: 'MED/42928415',
				pmid: '42928415',
				pmcid: 'PMC13696524',
				doi: '10.1002/advs.78445'
			},
			title:
				'Phosphate-Engineered DNA Reporters Boost CRISPR-Cas12a Trans-Cleavage for Rapid and Sensitive Nucleic Acid Detection.',
			abstractLicenseOk: true,
			landingUrl: 'https://europepmc.org/article/MED/42928415',
			categories: []
		});
		expect(first?.authors).toHaveLength(12);
		expect(first?.authors[0]).toEqual({ name: 'Rui Yang', orcid: '0009-0003-5839-1059' });
		expect(first?.publishedAt.toISOString()).toBe('2026-10-25T00:00:00.000Z');
		expect(first?.abstract).not.toMatch(/<[a-z]/i);
	});

	it('setzt abstractLicenseOk=false ohne offene Lizenz', () => {
		const { papers } = parseEuropePmcSearch(fixture('europepmc/search-crispr-core.json'));
		const closed = papers.find((p) => p.ids.pmid === '42905297');
		expect(closed?.abstract).toBeTruthy();
		expect(closed?.abstractLicenseOk).toBe(false);
		expect(closed?.pdfUrl).toBeUndefined();
	});

	it('normalisiert Preprints (SRC:PPR) inkl. JATS-Markup im Abstract', () => {
		const { papers } = parseEuropePmcSearch(fixture('europepmc/search-preprints-core.json'));
		expect(papers).toHaveLength(5);
		for (const p of papers) {
			expect(p.ids.europepmcId).toMatch(/^PPR\/PPR\d+$/);
			expect(p.ids.pmid).toBeUndefined();
			expect(p.ids.doi).toBeTruthy();
			expect(p.abstract).not.toMatch(/<\/?(?:p|bold|italic|title)>/);
		}
		const ccBy = papers.find((p) => p.ids.europepmcId === 'PPR/PPR1353367');
		expect(ccBy?.abstractLicenseOk).toBe(true);
		expect(ccBy?.authors).toHaveLength(39);
		expect(papers.filter((p) => p.abstractLicenseOk)).toHaveLength(1);
	});

	it('entfernt <i>-Markup aus Titeln (lite)', () => {
		const { papers } = parseEuropePmcSearch(fixture('europepmc/by-orcid-lite.json'));
		const titles = papers.map((p) => p.title);
		expect(titles).toContain('Cryptosporidium and irritable bowel syndrome.');
		expect(titles.join(' ')).not.toContain('<i>');
		// lite enthält keine Abstracts
		expect(papers.every((p) => p.abstract === undefined && !p.abstractLicenseOk)).toBe(true);
	});

	it('erhält Umlaute und strukturierte Abstracts', () => {
		const { papers } = parseEuropePmcSearch(fixture('europepmc/umlaut-author-core.json'));
		const names = papers.flatMap((p) => p.authors.map((a) => a.name));
		expect(names.some((n) => /ü|ß/.test(n))).toBe(true);
		for (const p of papers) expect(p.abstract ?? '').not.toContain('<h4>');
	});

	it('leere Treffer und Fehlerantworten', () => {
		expect(parseEuropePmcSearch(fixture('europepmc/search-empty.json')).papers).toEqual([]);
		expect(() => parseEuropePmcSearch(fixture('europepmc/error-503.json'))).toThrow(
			SourceParseError
		);
		expect(() => parseEuropePmcSearch('<html>')).toThrow(SourceParseError);
	});

	it('überspringt Datensätze ohne Pflichtfelder und führt arXiv-DOIs als arXiv-ID', () => {
		expect(normalizeEuropePmcResult({ id: '1', source: 'MED' })).toBeNull();
		const p = normalizeEuropePmcResult({
			id: 'PPR1',
			source: 'PPR',
			title: 'T',
			doi: '10.48550/arXiv.2103.00020',
			firstPublicationDate: '2021-02-26',
			license: 'cc0'
		});
		expect(p?.ids).toEqual({ europepmcId: 'PPR/PPR1', arxivId: '2103.00020' });
		// Ohne Abstract ist auch keine Abstract-Lizenz „ok“.
		expect(p?.abstractLicenseOk).toBe(false);
	});
});

describe('Hilfsfunktionen', () => {
	it('isOpenLicense', () => {
		expect(isOpenLicense('cc by')).toBe(true);
		expect(isOpenLicense('cc by-nc-nd')).toBe(true);
		expect(isOpenLicense('CC0')).toBe(true);
		expect(isOpenLicense(undefined)).toBe(false);
		expect(isOpenLicense('subscription')).toBe(false);
	});

	it('toEpmcAuthorName', () => {
		expect(toEpmcAuthorName('Rui Yang')).toBe('Yang R');
		expect(toEpmcAuthorName('Yang, Rui')).toBe('Yang R');
		expect(toEpmcAuthorName('Isra M. Alsaady')).toBe('Alsaady IM');
		expect(toEpmcAuthorName('Jean-Luc Picard')).toBe('Picard JL');
		expect(toEpmcAuthorName('Yang R')).toBe('Yang R');
		expect(toEpmcAuthorName('Müller')).toBe('Müller');
	});

	it('buildEuropePmcQuery', () => {
		expect(
			buildEuropePmcQuery(
				{ kind: 'keyword', value: 'crispr "trans-cleavage" -review' },
				since,
				until
			)
		).toBe(
			'(TITLE_ABS:crispr AND TITLE_ABS:"trans-cleavage" NOT TITLE_ABS:review) AND FIRST_IDATE:[2026-10-20 TO 2026-10-27]'
		);
		expect(
			buildEuropePmcQuery({ kind: 'author', value: '0000-0003-0676-8857' }, since, until)
		).toBe('(AUTHORID:"0000-0003-0676-8857") AND FIRST_IDATE:[2026-10-20 TO 2026-10-27]');
		expect(buildEuropePmcQuery({ kind: 'author', value: 'Rui Yang' }, since, until)).toBe(
			'(AUTH:"Yang R") AND FIRST_IDATE:[2026-10-20 TO 2026-10-27]'
		);
		expect(buildEuropePmcQuery({ kind: 'category', value: 'cs.DL' }, since, until)).toBeNull();
	});
});

describe('EuropePmcSource', () => {
	it('sucht mit core/json und folgt dem cursorMark', async () => {
		const page = JSON.parse(fixture('europepmc/search-crispr-core.json')) as Record<
			string,
			unknown
		>;
		const { epmc, fetch } = source(
			(_, i) => ({
				body: JSON.stringify({ ...page, nextCursorMark: `cursor-${i + 1}` })
			}),
			5
		);
		const papers = await epmc.search({ kind: 'keyword', value: 'CRISPR' }, since, {
			maxResults: 10
		});
		expect(fetch.calls).toHaveLength(2);
		const [a, b] = fetch.calls.map((c) => new URL(c.url).searchParams);
		expect(a?.get('resultType')).toBe('core');
		expect(a?.get('format')).toBe('json');
		expect(a?.get('cursorMark')).toBe('*');
		expect(a?.get('pageSize')).toBe('5');
		expect(b?.get('cursorMark')).toBe('cursor-1');
		expect(papers).toHaveLength(10);
		// ≥ 200 ms Abstand (5 req/s)
		expect((fetch.calls[1]?.at ?? 0) - (fetch.calls[0]?.at ?? 0)).toBeGreaterThanOrEqual(200);
	});

	it('stoppt, wenn weniger als eine volle Seite kommt', async () => {
		const { epmc, fetch } = source(() => ({
			body: fixture('europepmc/search-preprints-core.json')
		}));
		const papers = await epmc.search({ kind: 'keyword', value: 'malaria' }, since);
		expect(fetch.calls).toHaveLength(1);
		expect(papers).toHaveLength(5);
	});

	it('getById per DOI filtert exakt', async () => {
		const { epmc, fetch } = source(() => ({ body: fixture('europepmc/by-doi-core.json') }));
		const result = await epmc.getById({ type: 'doi', value: 'https://doi.org/10.1002/ADVS.78445' });
		expect(result).toHaveLength(1);
		expect(new URL(fetch.calls[0]?.url ?? '').searchParams.get('query')).toBe(
			'DOI:"10.1002/advs.78445"'
		);
		expect(await epmc.getById({ type: 'pmid', value: '1' })).toEqual([]);
	});

	it('baut ID-Abfragen für PMID, PMCID und Europe-PMC-ID', async () => {
		const { epmc, fetch } = source(() => ({ body: fixture('europepmc/search-empty.json') }));
		await epmc.getById({ type: 'pmid', value: '42928415' });
		await epmc.getById({ type: 'pmcid', value: '13696524' });
		await epmc.getById({ type: 'europepmc', value: 'PPR/PPR1347660' });
		await epmc.getById({ type: 'arxiv', value: '2103.00020' });
		expect(fetch.calls.map((c) => new URL(c.url).searchParams.get('query'))).toEqual([
			'EXT_ID:42928415 AND SRC:MED',
			'PMCID:PMC13696524',
			'EXT_ID:PPR1347660 AND SRC:PPR'
		]);
	});

	it('wiederholt 503 und meldet danach einen HTTP-Fehler', async () => {
		const { epmc, fetch } = source(() => ({
			status: 503,
			body: fixture('europepmc/error-503.json')
		}));
		await expect(epmc.search({ kind: 'keyword', value: 'x' }, since)).rejects.toBeInstanceOf(
			SourceHttpError
		);
		expect(fetch.calls).toHaveLength(2);
	});

	it('macht keinen Request für Kategorie-Abos', async () => {
		const { epmc, fetch } = source(() => ({ body: '' }));
		expect(await epmc.search({ kind: 'category', value: 'cs.DL' }, since)).toEqual([]);
		expect(fetch.calls).toHaveLength(0);
	});
});
