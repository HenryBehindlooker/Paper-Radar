import { describe, expect, it } from 'vitest';
import {
	bibtexAuthor,
	bibtexKey,
	escapeBibtex,
	toBibtex,
	toBibtexFile,
	type BibtexInput
} from '$lib/papers/bibtex';
import { paragraphs, sourceLabel } from '$lib/papers/format';
import { paperLinks } from '$lib/papers/links';
import { parseFeedFilter, parsePage, parseStateField } from '$lib/server/papers-view';

const maldacena: BibtexInput = {
	title: 'The Large N Limit of Superconformal Field Theories and Supergravity',
	authors: ['Juan M. Maldacena'],
	publishedAt: new Date('1997-11-27T23:53:13Z'),
	journal: 'Adv.Theor.Math.Phys.2:231-252,1998',
	doi: '10.1023/a:1026654312961',
	arxivId: 'hep-th/9711200',
	primaryCategory: 'hep-th',
	url: 'https://arxiv.org/abs/hep-th/9711200'
};

describe('escapeBibtex', () => {
	it('maskiert Sonderzeichen außerhalb von Mathematik', () => {
		expect(escapeBibtex('R&D at 50% #1 snake_case {x} ~ ^ \\')).toBe(
			'R\\&D at 50\\% \\#1 snake\\_case \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}'
		);
	});

	it('lässt $…$-Mathematik unverändert', () => {
		expect(escapeBibtex('Sheaves on $\\mathbb P^3$ & $x_1$')).toBe(
			'Sheaves on $\\mathbb P^3$ \\& $x_1$'
		);
	});

	it('Umlaute bleiben UTF-8, Leerraum wird normalisiert', () => {
		expect(escapeBibtex('Größe   und\nÜbersicht')).toBe('Größe und Übersicht');
	});
});

describe('bibtexAuthor / bibtexKey', () => {
	it('dreht Namen, Kollektive in Klammern', () => {
		expect(bibtexAuthor('Juan M. Maldacena')).toBe('Maldacena, Juan M.');
		expect(bibtexAuthor('Yang, Rui')).toBe('Yang, Rui');
		expect(bibtexAuthor('Plato')).toBe('Plato');
		expect(bibtexAuthor('H1 Collaboration')).toBe('{H1 Collaboration}');
		expect(bibtexAuthor('Jörg Müller')).toBe('Müller, Jörg');
	});

	it('Schlüssel aus Nachname, Jahr und erstem Titelwort (ASCII)', () => {
		expect(bibtexKey(maldacena)).toBe('maldacena1997large');
		expect(
			bibtexKey({
				title: 'Über $\\alpha$-Größen',
				authors: ['Jörg Müller'],
				publishedAt: new Date('2026-01-01')
			})
		).toBe('muller2026uber');
		expect(bibtexKey({ title: '', authors: [], publishedAt: new Date('2026-01-01') })).toBe(
			'anon2026paper'
		);
	});
});

describe('toBibtex', () => {
	it('Zeitschriftenartikel mit DOI und arXiv-Feldern', () => {
		expect(toBibtex(maldacena)).toBe(`@article{maldacena1997large,
  title = {{The Large N Limit of Superconformal Field Theories and Supergravity}},
  author = {Maldacena, Juan M.},
  year = {1997},
  month = nov,
  journal = {Adv.Theor.Math.Phys.2:231-252,1998},
  doi = {10.1023/a:1026654312961},
  eprint = {hep-th/9711200},
  archiveprefix = {arXiv},
  primaryclass = {hep-th},
  url = {https://arxiv.org/abs/hep-th/9711200}
}
`);
	});

	it('Preprint ohne Zeitschrift als @misc mit Hinweis', () => {
		const bib = toBibtex({
			title: 'Attention Is All You Need',
			authors: ['Ashish Vaswani', 'Noam Shazeer'],
			publishedAt: new Date('2017-06-12'),
			arxivId: '1706.03762',
			primaryCategory: 'cs.CL'
		});
		expect(bib.startsWith('@misc{vaswani2017attention,')).toBe(true);
		expect(bib).toContain('author = {Vaswani, Ashish and Shazeer, Noam}');
		expect(bib).toContain('note = {Preprint}');
		expect(bib).not.toContain('journal');
	});

	it('eindeutige Schlüssel in einer Datei', () => {
		const file = toBibtexFile([maldacena, maldacena, maldacena]);
		expect(file.match(/@article\{(\w+),/g)).toEqual([
			'@article{maldacena1997large,',
			'@article{maldacena1997largea,',
			'@article{maldacena1997largeb,'
		]);
	});
});

describe('paperLinks', () => {
	it('baut Links aus allen IDs, PDF nur https', () => {
		const links = paperLinks(
			{
				arxivId: '2103.00020',
				doi: '10.1002/(sici)1097',
				europepmcId: 'PPR/PPR1',
				pmid: '1',
				pmcid: 'PMC2',
				openalexId: 'W3'
			},
			'https://arxiv.org/pdf/2103.00020'
		);
		expect(links.map((l) => [l.kind, l.url])).toEqual([
			['arxiv', 'https://arxiv.org/abs/2103.00020'],
			['doi', 'https://doi.org/10.1002/(sici)1097'],
			['europepmc', 'https://europepmc.org/article/PPR/PPR1'],
			['pubmed', 'https://pubmed.ncbi.nlm.nih.gov/1/'],
			['pmc', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2/'],
			['openalex', 'https://openalex.org/W3'],
			['pdf', 'https://arxiv.org/pdf/2103.00020']
		]);
		expect(paperLinks({}, 'javascript:alert(1)')).toEqual([]);
	});
});

describe('Formatierung und Parser', () => {
	it('sourceLabel, paragraphs', () => {
		expect(sourceLabel('europepmc')).toBe('Europe PMC');
		expect(sourceLabel('x')).toBe('x');
		expect(paragraphs('A\n\nB\n \nC')).toEqual(['A', 'B', 'C']);
	});

	it('parseFeedFilter, parsePage, parseStateField', () => {
		expect(parseFeedFilter('ungelesen')).toBe('ungelesen');
		expect(parseFeedFilter('<script>')).toBe('alle');
		expect(parsePage('3')).toBe(3);
		expect(parsePage('0')).toBe(1);
		expect(parsePage('-2')).toBe(1);
		expect(parsePage('abc')).toBe(1);
		expect(parsePage('1.5')).toBe(1);
		expect(parseStateField('saved')).toBe('saved');
		expect(parseStateField('score')).toBeNull();
	});
});
