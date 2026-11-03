import { describe, expect, it } from 'vitest';
import {
	arxivIdFromDoi,
	arxivVersion,
	cleanTitle,
	collapseWhitespace,
	dateFromParts,
	decodeEntities,
	normalizeArxivId,
	normalizeDoi,
	normalizeOpenAlexId,
	normalizeOrcid,
	normalizePmcid,
	normalizePmid,
	parseDate,
	stripMarkup
} from '$lib/server/sources/normalize';

describe('normalizeArxivId', () => {
	it.each([
		['2103.00020', '2103.00020'],
		['2103.00020v1', '2103.00020'],
		['1706.03762v5', '1706.03762'],
		['0704.0001', '0704.0001'],
		['arXiv:2611.01109v2', '2611.01109'],
		['http://arxiv.org/abs/2103.00020v1', '2103.00020'],
		['https://arxiv.org/pdf/2103.00020v1', '2103.00020'],
		['https://arxiv.org/pdf/2103.00020v1.pdf', '2103.00020'],
		['oai:arXiv.org:2610.38691v2', '2610.38691'],
		['hep-th/9711200', 'hep-th/9711200'],
		['hep-th/9711200v3', 'hep-th/9711200'],
		['http://arxiv.org/abs/hep-th/9711200v3', 'hep-th/9711200'],
		['math.AG/0501001', 'math/0501001'],
		['cond-mat/0702661v2', 'cond-mat/0702661']
	])('%s → %s', (input, expected) => {
		expect(normalizeArxivId(input)).toBe(expected);
	});

	it.each(['1234.1234', 'cond—mat/0709123', '', 'foo', '2103.000201'])(
		'lehnt ungültige ID %j ab',
		(input) => {
			expect(normalizeArxivId(input)).toBeNull();
		}
	);

	it('liest die Version', () => {
		expect(arxivVersion('2103.00020v12')).toBe(12);
		expect(arxivVersion('2103.00020')).toBeUndefined();
	});
});

describe('normalizeDoi', () => {
	it.each([
		['10.1023/A:1026654312961', '10.1023/a:1026654312961'],
		['https://doi.org/10.1002/advs.78445', '10.1002/advs.78445'],
		['http://dx.doi.org/10.1002/ADVS.78445', '10.1002/advs.78445'],
		['doi:10.1007/s00284-026-05157-w', '10.1007/s00284-026-05157-w'],
		['https://doi.org/10.1002%2F%28SICI%291097', '10.1002/(sici)1097'],
		['  10.21203/rs.3.rs-10946928/v1 ', '10.21203/rs.3.rs-10946928/v1']
	])('%s → %s', (input, expected) => {
		expect(normalizeDoi(input)).toBe(expected);
	});

	it('lehnt Nicht-DOIs ab', () => {
		expect(normalizeDoi('11.1000/abc')).toBeNull();
		expect(normalizeDoi('')).toBeNull();
	});

	it('erkennt arXiv-DataCite-DOIs', () => {
		expect(arxivIdFromDoi('10.48550/arXiv.1706.03762')).toBe('1706.03762');
		expect(arxivIdFromDoi('10.48550/arxiv.hep-th/9711200')).toBe('hep-th/9711200');
		expect(arxivIdFromDoi('10.1002/advs.78445')).toBeNull();
	});
});

describe('weitere IDs', () => {
	it('prüft ORCID inkl. Prüfziffer', () => {
		expect(normalizeOrcid('https://orcid.org/0000-0002-1825-0097')).toBe('0000-0002-1825-0097');
		expect(normalizeOrcid('0000-0002-1694-233x')).toBe('0000-0002-1694-233X');
		expect(normalizeOrcid('0009-0003-5839-1059')).toBe('0009-0003-5839-1059');
		expect(normalizeOrcid('0000-0002-1825-0098')).toBeNull();
		expect(normalizeOrcid('Rui Yang')).toBeNull();
	});

	it('normalisiert PMCID, PMID, OpenAlex-ID', () => {
		expect(normalizePmcid('13696524')).toBe('PMC13696524');
		expect(normalizePmcid('pmc13696524')).toBe('PMC13696524');
		expect(normalizePmid('42928415')).toBe('42928415');
		expect(normalizePmid('PMC1')).toBeNull();
		expect(normalizeOpenAlexId('https://openalex.org/W2166248051')).toBe('W2166248051');
		expect(normalizeOpenAlexId('a5018077134')).toBe('A5018077134');
		expect(normalizeOpenAlexId('X1')).toBeNull();
	});
});

describe('Text', () => {
	it('dekodiert Entities', () => {
		expect(decodeEntities('Smith &amp; Wesson &lt;3 &#246;&#x00fc; &unknown;')).toBe(
			'Smith & Wesson <3 öü &unknown;'
		);
	});

	it('fasst Leerraum zusammen (arXiv-Titel mit Zeilenumbruch)', () => {
		expect(
			collapseWhitespace(
				'Multi-Electron Production at High Transverse Momenta in ep Collisions at\n HERA'
			)
		).toBe('Multi-Electron Production at High Transverse Momenta in ep Collisions at HERA');
	});

	it('erhält LaTeX in Titeln unverändert', () => {
		const title = 'Moduli spaces of rank 2 sheaves on $\\mathbb P^3$ via Quot schemes';
		expect(cleanTitle(title)).toBe(title);
		expect(cleanTitle('Normality for $\\operatorname{GL}_n$')).toBe(
			'Normality for $\\operatorname{GL}_n$'
		);
	});

	it('entfernt HTML-Markup aus Titeln (Europe PMC)', () => {
		expect(cleanTitle('<i>Cryptosporidium</i> and irritable bowel syndrome.')).toBe(
			'Cryptosporidium and irritable bowel syndrome.'
		);
	});

	it('entfernt JATS-Markup und die Überschrift „ABSTRACT“ (Crossref)', () => {
		const jats =
			'<jats:title>ABSTRACT</jats:title>\n  <jats:p>\n  First <jats:italic>para</jats:italic>.\n</jats:p><jats:p>Second &lt; para.</jats:p>';
		expect(stripMarkup(jats)).toBe('First para.\n\nSecond < para.');
	});

	it('behält Abschnittsüberschriften strukturierter Abstracts', () => {
		expect(stripMarkup('<h4>Background</h4>Text A.<h4>Methods</h4>Text B.')).toBe(
			'Background\n\nText A.\n\nMethods\n\nText B.'
		);
	});

	it('kodiertes < in Formeln wird nicht als Tag entfernt', () => {
		expect(stripMarkup('<p>for $a &lt; b$ and $c &gt; d$</p>')).toBe('for $a < b$ and $c > d$');
	});

	it('kommt mit sehr langen Texten zurecht', () => {
		const long = `<p>${'Lorem ipsum dolor sit amet. '.repeat(5000)}</p>`;
		const out = stripMarkup(long);
		expect(out.length).toBeGreaterThan(100_000);
		expect(out).not.toContain('<');
	});
});

describe('Datum', () => {
	it('parst ISO, reines Datum und RFC 2822', () => {
		expect(parseDate('2026-10-25')?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
		expect(parseDate('2021-02-26T19:04:58Z')?.toISOString()).toBe('2021-02-26T19:04:58.000Z');
		expect(parseDate('Tue, 03 Nov 2026 00:00:00 -0500')?.toISOString()).toBe(
			'2026-11-03T05:00:00.000Z'
		);
		expect(parseDate('')).toBeUndefined();
		expect(parseDate('kein Datum')).toBeUndefined();
	});

	it('baut Daten aus Crossref-date-parts', () => {
		expect(dateFromParts([1999, 4])?.toISOString()).toBe('1999-04-01T00:00:00.000Z');
		expect(dateFromParts([2026])?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
		expect(dateFromParts([null])).toBeUndefined();
		expect(dateFromParts([])).toBeUndefined();
	});
});
