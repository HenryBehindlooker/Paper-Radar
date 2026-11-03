import { describe, expect, it } from 'vitest';
import { parseWebsearch, renderWebsearch } from '$lib/server/sources/websearch';

const plain = {
	term: (t: { text: string; phrase: boolean }) => (t.phrase ? `"${t.text}"` : t.text),
	and: '&',
	or: '|',
	andNot: '&!'
};
const render = (q: string) => renderWebsearch(parseWebsearch(q), plain);

describe('parseWebsearch / renderWebsearch', () => {
	it('verknüpft Wörter mit UND', () => {
		expect(render('crispr diagnostics')).toBe('crispr & diagnostics');
	});

	it('erkennt Phrasen', () => {
		expect(render('"large language models" evaluation')).toBe(
			'"large language models" & evaluation'
		);
	});

	it('OR bindet stärker als das implizite UND (wie Postgres)', () => {
		expect(render('malaria vaccine or vaccination')).toBe('malaria & (vaccine | vaccination)');
		expect(render('a OR b or c')).toBe('(a | b | c)');
	});

	it('Ausschlüsse mit Minus', () => {
		expect(render('supernova -"crab nebula" -review')).toBe('supernova &! "crab nebula" &! review');
	});

	it('nur Ausschlüsse → nicht ausdrückbar', () => {
		expect(render('-foo -bar')).toBeNull();
		expect(render('')).toBeNull();
		expect(render('   ')).toBeNull();
	});

	it('Umlaute und Sonderzeichen', () => {
		expect(render('Übersetzung Größe')).toBe('Übersetzung & Größe');
		expect(render('C++ (compiler):')).toBe('C++ & compiler');
		expect(render('CRISPR-Cas12a')).toBe('CRISPR-Cas12a');
		expect(render('foo:bar')).toBe('"foo bar"');
	});

	it('unvollständige Anführungszeichen und führendes OR', () => {
		expect(render('"open quote')).toBe('"open quote"');
		expect(render('or alpha')).toBe('alpha');
	});

	it('verwirft Ausschlüsse innerhalb von ODER-Gruppen', () => {
		expect(render('a or -b')).toBe('a');
	});

	it('liefert die Struktur', () => {
		expect(parseWebsearch('a "b c" -d')).toEqual([
			[{ text: 'a', phrase: false, negated: false }],
			[{ text: 'b c', phrase: true, negated: false }],
			[{ text: 'd', phrase: false, negated: true }]
		]);
	});
});
