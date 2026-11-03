import { describe, expect, it } from 'vitest';
import {
	facetFromPaper,
	idEntries,
	mergeFacets,
	normalizeAuthorName,
	type PaperFacet
} from '$lib/server/db/merge';
import { InvalidQueryError, normalizeQuery } from '$lib/server/db/queries';

function facet(overrides: Partial<PaperFacet> = {}): PaperFacet {
	return {
		metadataSource: 'arxiv',
		title: 'Preprint title',
		abstract: 'arXiv abstract',
		abstractLicenseOk: true,
		abstractSource: 'arxiv',
		sources: ['arxiv'],
		categories: ['cs.DL'],
		journal: null,
		landingUrl: 'https://arxiv.org/abs/2610.00001',
		pdfUrl: 'https://arxiv.org/pdf/2610.00001',
		publishedAt: new Date('2026-10-01T00:00:00Z'),
		sourceUpdatedAt: new Date('2026-10-01T00:00:00Z'),
		citedByCount: null,
		authorCount: 3,
		...overrides
	};
}

describe('mergeFacets', () => {
	it('Verlagsversion (Crossref) übernimmt Titel, Landing-URL und Autoren', () => {
		const { facet: merged, takeIncomingAuthors } = mergeFacets(
			facet(),
			facet({
				metadataSource: 'crossref',
				title: 'Published title',
				abstract: null,
				abstractSource: null,
				abstractLicenseOk: false,
				sources: ['crossref'],
				categories: [],
				journal: 'Nature',
				landingUrl: 'https://doi.org/10.1/x',
				pdfUrl: null,
				publishedAt: new Date('2026-12-01T00:00:00Z'),
				sourceUpdatedAt: new Date('2026-12-02T00:00:00Z'),
				authorCount: 3
			})
		);
		expect(takeIncomingAuthors).toBe(true);
		expect(merged).toMatchObject({
			metadataSource: 'crossref',
			title: 'Published title',
			landingUrl: 'https://doi.org/10.1/x',
			journal: 'Nature',
			// Abstract, PDF-Link und frühestes Datum bleiben vom Preprint.
			abstract: 'arXiv abstract',
			abstractSource: 'arxiv',
			pdfUrl: 'https://arxiv.org/pdf/2610.00001',
			sources: ['arxiv', 'crossref'],
			categories: ['cs.DL']
		});
		expect(merged.publishedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
		expect(merged.sourceUpdatedAt.toISOString()).toBe('2026-12-02T00:00:00.000Z');
	});

	it('niedrigere Priorität ändert Metadaten nicht, ergänzt aber Fehlendes', () => {
		const { facet: merged, takeIncomingAuthors } = mergeFacets(
			facet({ metadataSource: 'crossref', authorCount: 0, journal: null, citedByCount: null }),
			facet({
				metadataSource: 'openalex',
				title: 'OpenAlex title',
				abstract: null,
				abstractSource: null,
				abstractLicenseOk: false,
				citedByCount: 42,
				journal: 'J',
				authorCount: 2
			})
		);
		expect(merged.title).toBe('Preprint title');
		expect(merged.metadataSource).toBe('crossref');
		expect(merged.citedByCount).toBe(42);
		expect(merged.journal).toBe('J');
		expect(takeIncomingAuthors).toBe(true);
		expect(merged.authorCount).toBe(2);
	});

	it('anzeigbarer Abstract schlägt nicht anzeigbaren – in beide Richtungen', () => {
		const closed = facet({
			metadataSource: 'europepmc',
			abstract: 'closed',
			abstractLicenseOk: false,
			abstractSource: 'europepmc'
		});
		const open = facet({
			metadataSource: 'crossref',
			abstract: 'open',
			abstractLicenseOk: true,
			abstractSource: 'crossref'
		});
		expect(mergeFacets(closed, open).facet.abstract).toBe('open');
		expect(mergeFacets(open, closed).facet.abstract).toBe('open');
	});

	it('gleiche Lizenzlage: nur dieselbe Quelle aktualisiert den Abstract', () => {
		const a = facet({ abstract: 'v1', abstractSource: 'arxiv' });
		expect(mergeFacets(a, facet({ abstract: 'v2', abstractSource: 'arxiv' })).facet.abstract).toBe(
			'v2'
		);
		expect(
			mergeFacets(
				a,
				facet({ metadataSource: 'crossref', abstract: 'other', abstractSource: 'crossref' })
			).facet.abstract
		).toBe('v1');
		expect(
			mergeFacets(facet({ abstract: null, abstractSource: null, abstractLicenseOk: false }), a)
				.facet.abstract
		).toBe('v1');
	});

	it('leere Autorenliste ersetzt keine vorhandene', () => {
		const r = mergeFacets(facet(), facet({ metadataSource: 'crossref', authorCount: 0 }));
		expect(r.takeIncomingAuthors).toBe(false);
		expect(r.facet.authorCount).toBe(3);
	});

	it('facetFromPaper setzt abstractSource nur mit Abstract', () => {
		const f = facetFromPaper({
			source: 'crossref',
			ids: { doi: '10.1/x' },
			title: 'T',
			abstractLicenseOk: true,
			authors: [],
			categories: [],
			publishedAt: new Date(),
			updatedAt: new Date(),
			landingUrl: 'https://doi.org/10.1/x'
		});
		expect(f.abstract).toBeNull();
		expect(f.abstractSource).toBeNull();
		expect(f.abstractLicenseOk).toBe(false);
	});
});

describe('idEntries / normalizeAuthorName', () => {
	it('liefert alle IDs deterministisch sortiert', () => {
		expect(
			idEntries({ pmid: '1', doi: '10.1/x', arxivId: '2610.00001', europepmcId: 'MED/1' })
		).toEqual([
			{ type: 'arxiv', value: '2610.00001' },
			{ type: 'doi', value: '10.1/x' },
			{ type: 'europepmc', value: 'MED/1' },
			{ type: 'pmid', value: '1' }
		]);
		expect(idEntries({})).toEqual([]);
	});

	it('normalisiert Namen ohne Diakritika und Satzzeichen', () => {
		expect(normalizeAuthorName('Jörg  Müller-Lüdenscheidt')).toBe('jorg muller ludenscheidt');
		expect(normalizeAuthorName('Søren Kierkegaard')).toBe('søren kierkegaard');
		expect(normalizeAuthorName('Groß, R.')).toBe('gross r');
		expect(normalizeAuthorName("Mou'th Hourani")).toBe('mou th hourani');
	});
});

describe('normalizeQuery', () => {
	it('keyword: Leerraum und Groß-/Kleinschreibung', () => {
		expect(normalizeQuery('keyword', '  Graph   Neural  Networks ')).toBe('graph neural networks');
		expect(normalizeQuery('keyword', '"Large Language" OR LLM -Survey')).toBe(
			'"large language" or llm -survey'
		);
		expect(() => normalizeQuery('keyword', '-nur -ausschluss')).toThrow(InvalidQueryError);
		expect(() => normalizeQuery('keyword', '   ')).toThrow(InvalidQueryError);
		expect(() => normalizeQuery('keyword', 'x'.repeat(501))).toThrow(InvalidQueryError);
	});

	it('category: unverändert, aber validiert', () => {
		expect(normalizeQuery('category', ' cs.DL ')).toBe('cs.DL');
		expect(normalizeQuery('category', 'hep-th')).toBe('hep-th');
		expect(() => normalizeQuery('category', 'cs.DL; DROP TABLE')).toThrow(InvalidQueryError);
	});

	it('author: ORCID oder „Vorname Nachname“', () => {
		expect(normalizeQuery('author', 'https://orcid.org/0000-0002-1825-0097')).toBe(
			'0000-0002-1825-0097'
		);
		expect(normalizeQuery('author', 'Yang,  Rui')).toBe('rui yang');
		expect(normalizeQuery('author', 'Rui Yang')).toBe('rui yang');
		expect(normalizeQuery('author', 'Jörg Müller')).toBe('jörg müller');
		expect(() => normalizeQuery('author', 'x')).toThrow(InvalidQueryError);
	});
});
