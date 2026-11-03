import { describe, expect, it } from 'vitest';
import {
	ArxivSource,
	arxivDateRange,
	buildArxivQuery,
	parseArxivAtom,
	parseArxivRss,
	parseArxivRssError
} from '$lib/server/sources/arxiv';
import { SourceHttpError, SourceParseError } from '$lib/server/sources/errors';
import { HttpClient } from '$lib/server/sources/http';
import { RateLimiter } from '$lib/server/sources/rate-limiter';
import { FakeClock, fixture, mockFetch, type MockReply } from './helpers';

const since = new Date('2026-10-20T00:00:00Z');
const until = new Date('2026-10-27T00:00:00Z');

function source(reply: (url: string, i: number) => MockReply, pageSize?: number) {
	const clock = new FakeClock();
	const limiter = new RateLimiter({
		name: 'arxiv',
		minIntervalMs: 3000,
		maxConcurrent: 1,
		spacingFromCompletion: true,
		clock
	});
	const fetch = mockFetch(reply, clock);
	const http = new HttpClient({ source: 'arxiv', limiter, userAgent: 'test', fetch, clock });
	return {
		arxiv: new ArxivSource({ http, now: () => until, ...(pageSize ? { pageSize } : {}) }),
		fetch
	};
}

describe('parseArxivAtom', () => {
	it('parst eine id_list-Antwort mit alten und neuen IDs', () => {
		const { papers, totalResults, errors } = parseArxivAtom(fixture('arxiv/idlist-mixed.atom.xml'));
		expect(totalResults).toBe(3);
		expect(errors).toEqual([]);
		expect(papers.map((p) => p.ids.arxivId).sort()).toEqual([
			'1706.03762',
			'2103.00020',
			'hep-th/9711200'
		]);

		const maldacena = papers.find((p) => p.ids.arxivId === 'hep-th/9711200');
		expect(maldacena).toMatchObject({
			source: 'arxiv',
			ids: { arxivId: 'hep-th/9711200', doi: '10.1023/a:1026654312961' },
			title: 'The Large N Limit of Superconformal Field Theories and Supergravity',
			abstractLicenseOk: true,
			authors: [{ name: 'Juan M. Maldacena' }],
			categories: ['hep-th'],
			landingUrl: 'https://arxiv.org/abs/hep-th/9711200',
			pdfUrl: 'https://arxiv.org/pdf/hep-th/9711200',
			journal: 'Adv.Theor.Math.Phys.2:231-252,1998'
		});
		expect(maldacena?.publishedAt.toISOString()).toBe('1997-11-27T23:53:13.000Z');
		expect(maldacena?.updatedAt.toISOString()).toBe('1998-01-22T15:42:41.000Z');
		// LaTeX im Abstract bleibt erhalten, Leerraum wird normalisiert.
		expect(maldacena?.abstract).toContain('large $N$ limit');
		expect(maldacena?.abstract).toContain('${\\cal N} =4$');
		expect(maldacena?.abstract).not.toMatch(/\s{2,}|\n/);

		const clip = papers.find((p) => p.ids.arxivId === '2103.00020');
		expect(clip?.authors).toHaveLength(12);
		expect(clip?.categories).toEqual(['cs.CV', 'cs.LG']);
		expect(clip?.ids.doi).toBeUndefined();
	});

	it('parst eine Kategorie-Suche', () => {
		const { papers } = parseArxivAtom(fixture('arxiv/search-cs-dl.atom.xml'));
		expect(papers).toHaveLength(5);
		for (const p of papers) {
			expect(p.ids.arxivId).toMatch(/^\d{4}\.\d{5}$/);
			expect(p.categories).toContain('cs.DL');
			expect(p.title.length).toBeGreaterThan(0);
			expect(p.publishedAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
		}
	});

	it('liefert für leere Treffer und fehlerhafte IDs eine leere Liste', () => {
		expect(parseArxivAtom(fixture('arxiv/search-empty.atom.xml')).papers).toEqual([]);
		// Live geprüft: arXiv antwortet auf eine fehlerhafte ID inzwischen mit leerem Feed.
		expect(parseArxivAtom(fixture('arxiv/error-malformed-id.atom.xml')).papers).toEqual([]);
	});

	it('erkennt Fehler-Einträge im älteren, dokumentierten Format', () => {
		const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
			<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234.12345</id>
			<title>Error</title><summary>incorrect id format for 1234.12345</summary>
			<updated>2007-10-12T00:00:00-04:00</updated></entry></feed>`;
		const result = parseArxivAtom(xml);
		expect(result.papers).toEqual([]);
		expect(result.errors).toEqual(['incorrect id format for 1234.12345']);
	});

	it('wirft bei kaputtem XML', () => {
		expect(() => parseArxivAtom('<feed><entry>')).toThrow(SourceParseError);
		expect(() => parseArxivAtom('<html></html>')).toThrow(SourceParseError);
	});

	it('überspringt Einträge ohne Pflichtfelder', () => {
		const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
			<entry><id>http://arxiv.org/abs/2103.00020v1</id><title></title><published>2021-02-26T19:04:58Z</published></entry>
			<entry><id>http://arxiv.org/abs/2103.00021v1</id><title>Ok</title><published>2021-02-26T19:04:58Z</published></entry>
		</feed>`;
		const { papers } = parseArxivAtom(xml);
		expect(papers.map((p) => p.ids.arxivId)).toEqual(['2103.00021']);
		expect(papers[0]?.abstract).toBeUndefined();
		expect(papers[0]?.authors).toEqual([]);
	});

	it('ignoriert arXivs eigene DataCite-DOI', () => {
		const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
			<entry><id>http://arxiv.org/abs/2103.00021v1</id><title>T</title><published>2021-02-26T19:04:58Z</published>
			<arxiv:doi>10.48550/arXiv.2103.00021</arxiv:doi></entry></feed>`;
		expect(parseArxivAtom(xml).papers[0]?.ids).toEqual({ arxivId: '2103.00021' });
	});
});

describe('parseArxivRss', () => {
	it('parst den täglichen Feed inkl. Announce-Type', () => {
		const items = parseArxivRss(fixture('arxiv/rss-cs-dl.rss.xml'));
		expect(items).toHaveLength(13);
		const types = items.map((i) => i.announceType);
		expect(types.filter((t) => t === 'new')).toHaveLength(3);
		expect(types.filter((t) => t === 'cross')).toHaveLength(7);
		expect(types.filter((t) => t === 'replace')).toHaveLength(1);
		expect(types.filter((t) => t === 'replace-cross')).toHaveLength(2);

		const first = items[0];
		expect(first?.paper.ids.arxivId).toBe('2611.01109');
		expect(first?.version).toBe(1);
		expect(first?.paper.abstract).toMatch(/^Academic contexts have changed/);
		expect(first?.paper.authors.map((a) => a.name)).toEqual([
			'Jagan B L',
			'Sudhi S Vijayan',
			'Renjith V R',
			'Arunkumar V R'
		]);
		expect(first?.paper.journal).toContain('Library Gateway');
		expect(first?.paper.publishedAt.toISOString()).toBe('2026-11-03T05:00:00.000Z');
	});

	it('übernimmt DOI und mehrere Kategorien', () => {
		const items = parseArxivRss(fixture('arxiv/rss-cs-dl.rss.xml'));
		const withDoi = items.find((i) => i.paper.ids.arxivId === '2610.41552');
		expect(withDoi?.paper.ids.doi).toBe('10.1007/s11192-026-05892-8');
		expect(withDoi?.paper.categories).toEqual(['cs.CL', 'cs.DL', 'cs.IR']);
		expect(withDoi?.version).toBe(2);
	});

	it('erhält LaTeX in Titeln (math.AG)', () => {
		const items = parseArxivRss(fixture('arxiv/rss-math-ag.rss.xml'));
		expect(items).toHaveLength(85);
		const titles = items.map((i) => i.paper.title);
		expect(titles).toContain('Moduli spaces of rank 2 sheaves on $\\mathbb P^3$ via Quot schemes');
		expect(titles.some((t) => t.includes('$\\mathcal{H}_2$'))).toBe(true);
	});

	it('Sonderzeichen in Autorennamen (Apostroph)', () => {
		const items = parseArxivRss(fixture('arxiv/rss-cs-dl.rss.xml'));
		const names = items.flatMap((i) => i.paper.authors.map((a) => a.name));
		expect(names).toContain("Mou'th Hourani");
	});

	it('erkennt die Fehlerantwort bei unbekannter Kategorie', () => {
		const body = fixture('arxiv/rss-unknown-category.rss.xml');
		expect(parseArxivRss(body)).toEqual([]);
		expect(parseArxivRssError(body)).toMatch(/^Bad archive 'foo'/);
		expect(parseArxivRssError(fixture('arxiv/rss-cs-dl.rss.xml'))).toBeUndefined();
	});
});

describe('buildArxivQuery', () => {
	it('übersetzt Keyword-Abos', () => {
		expect(
			buildArxivQuery({ kind: 'keyword', value: '"large language" or llm -survey' }, since, until)
		).toBe(
			'((all:"large language" OR all:llm) ANDNOT all:survey) AND submittedDate:[202610200000 TO 202610270000]'
		);
	});

	it('übersetzt Kategorie- und Autor-Abos', () => {
		expect(buildArxivQuery({ kind: 'category', value: 'cs.DL' }, since, until)).toBe(
			'(cat:cs.DL) AND submittedDate:[202610200000 TO 202610270000]'
		);
		expect(buildArxivQuery({ kind: 'author', value: 'Maldacena, Juan' }, since, until)).toBe(
			'(au:"Juan Maldacena") AND submittedDate:[202610200000 TO 202610270000]'
		);
	});

	it('liefert null für nicht ausdrückbare Abfragen', () => {
		expect(
			buildArxivQuery({ kind: 'author', value: '0000-0002-1825-0097' }, since, until)
		).toBeNull();
		expect(buildArxivQuery({ kind: 'category', value: 'cs DL; drop' }, since, until)).toBeNull();
		expect(
			buildArxivQuery({ kind: 'keyword', value: '-nur -ausschluss' }, since, until)
		).toBeNull();
	});

	it('formatiert den Datumsbereich in GMT', () => {
		expect(arxivDateRange(new Date('2026-01-02T03:04:59Z'), new Date('2026-01-03T00:00:00Z'))).toBe(
			'submittedDate:[202601020304 TO 202601030000]'
		);
	});
});

describe('ArxivSource', () => {
	it('sucht mit korrekten Parametern und hält 3 s Abstand zwischen Seiten', async () => {
		const page = fixture('arxiv/search-cs-dl.atom.xml');
		const { arxiv, fetch } = source(() => ({ body: page }));
		const papers = await arxiv.search({ kind: 'category', value: 'cs.DL' }, since, {
			maxResults: 200
		});
		expect(papers).toHaveLength(5);
		expect(fetch.calls).toHaveLength(1);
		const url = new URL(fetch.calls[0]?.url ?? '');
		expect(url.origin + url.pathname).toBe('https://export.arxiv.org/api/query');
		expect(url.searchParams.get('search_query')).toBe(
			'(cat:cs.DL) AND submittedDate:[202610200000 TO 202610270000]'
		);
		expect(url.searchParams.get('sortBy')).toBe('submittedDate');
		expect(url.searchParams.get('max_results')).toBe('100');
	});

	it('begrenzt auf maxResults und hält das Rate-Limit über mehrere Suchen ein', async () => {
		const page = fixture('arxiv/search-cs-dl.atom.xml');
		const { arxiv, fetch } = source(() => ({ body: page }));
		await arxiv.search({ kind: 'keyword', value: 'citation' }, since, { maxResults: 3 });
		expect(new URL(fetch.calls[0]?.url ?? '').searchParams.get('max_results')).toBe('3');
		// Zwei separate Suchen nacheinander → Abstand ≥ 3 s
		await arxiv.search({ kind: 'keyword', value: 'citation' }, since, { maxResults: 3 });
		const gap = (fetch.calls[1]?.at ?? 0) - (fetch.calls[0]?.at ?? 0);
		expect(gap).toBeGreaterThanOrEqual(3000);
	});

	it('paginiert über start/max_results mit ≥ 3 s Abstand', async () => {
		// Fixture: totalResults=15, 5 Einträge pro Antwort.
		const page = fixture('arxiv/search-cs-dl.atom.xml');
		const { arxiv, fetch } = source(() => ({ body: page }), 5);
		const papers = await arxiv.search({ kind: 'category', value: 'cs.DL' }, since, {
			maxResults: 50
		});
		expect(fetch.calls.map((c) => new URL(c.url).searchParams.get('start'))).toEqual([
			'0',
			'5',
			'10'
		]);
		// Identische Seiten in der Attrappe → seitenübergreifend dedupliziert.
		expect(papers).toHaveLength(5);
		for (let i = 1; i < fetch.calls.length; i++) {
			expect((fetch.calls[i]?.at ?? 0) - (fetch.calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
				3000
			);
		}
	});

	it('macht keinen Request für nicht unterstützte Abfragen', async () => {
		const { arxiv, fetch } = source(() => ({ body: '' }));
		expect(await arxiv.search({ kind: 'author', value: '0000-0002-1825-0097' }, since)).toEqual([]);
		expect(await arxiv.getById({ type: 'doi', value: '10.1/x' })).toEqual([]);
		expect(await arxiv.getById({ type: 'arxiv', value: 'kaputt' })).toEqual([]);
		expect(fetch.calls).toHaveLength(0);
	});

	it('getById normalisiert die ID und filtert exakt', async () => {
		const { arxiv, fetch } = source(() => ({ body: fixture('arxiv/idlist-mixed.atom.xml') }));
		const result = await arxiv.getById({ type: 'arxiv', value: 'arXiv:hep-th/9711200v3' });
		expect(result).toHaveLength(1);
		expect(result[0]?.ids.arxivId).toBe('hep-th/9711200');
		expect(new URL(fetch.calls[0]?.url ?? '').searchParams.get('id_list')).toBe('hep-th/9711200');
	});

	it('bündelt RSS-Kategorien und liefert standardmäßig nur new/cross', async () => {
		const { arxiv, fetch } = source(() => ({ body: fixture('arxiv/rss-cs-dl.rss.xml') }));
		const items = await arxiv.fetchDailyAnnouncements(['cs.DL', 'cs.DL', 'math.AG', 'kaputt!']);
		expect(fetch.calls.map((c) => c.url)).toEqual(['https://rss.arxiv.org/rss/cs.DL+math.AG']);
		expect(items).toHaveLength(10);
		expect(items.every((i) => i.announceType === 'new' || i.announceType === 'cross')).toBe(true);

		const all = await arxiv.fetchDailyAnnouncements(['cs.DL'], { includeReplacements: true });
		expect(all).toHaveLength(13);
	});

	it('teilt viele Kategorien auf mehrere Requests auf – mit 3 s Abstand', async () => {
		const { arxiv, fetch } = source(() => ({ body: fixture('arxiv/rss-nlin-cg.rss.xml') }));
		const cats = Array.from({ length: 25 }, (_, i) => `cs.X${String.fromCharCode(65 + i)}`);
		await arxiv.fetchDailyAnnouncements(cats);
		expect(fetch.calls).toHaveLength(3);
		for (let i = 1; i < fetch.calls.length; i++) {
			expect((fetch.calls[i]?.at ?? 0) - (fetch.calls[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
				3000
			);
		}
	});

	it('meldet unbekannte Kategorien als HTTP-Fehler mit Begründung', async () => {
		const { arxiv } = source(() => ({
			status: 400,
			body: fixture('arxiv/rss-unknown-category.rss.xml')
		}));
		const error = await arxiv.fetchDailyAnnouncements(['foo.BAR']).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SourceHttpError);
		expect((error as SourceHttpError).body).toMatch(/Bad archive/);
	});
});
