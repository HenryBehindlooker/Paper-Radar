/**
 * BibTeX-Export als reine Funktionen. Ausgabe ist UTF-8 (biber/biblatex verarbeiten
 * Umlaute direkt); LaTeX-Mathematik in `$…$` bleibt unverändert, Sonderzeichen außerhalb
 * werden maskiert.
 */

export interface BibtexInput {
	title: string;
	authors: readonly string[];
	publishedAt: Date;
	journal?: string | null;
	doi?: string | null;
	arxivId?: string | null;
	primaryCategory?: string | null;
	url?: string | null;
	pmid?: string | null;
}

const SPECIAL = /[&%#_{}~^\\]/g;
const REPLACEMENTS: Record<string, string> = {
	'&': '\\&',
	'%': '\\%',
	'#': '\\#',
	_: '\\_',
	'{': '\\{',
	'}': '\\}',
	'~': '\\textasciitilde{}',
	'^': '\\textasciicircum{}',
	'\\': '\\textbackslash{}'
};

/** Maskiert BibTeX/LaTeX-Sonderzeichen außerhalb von `$…$`-Mathematik. */
export function escapeBibtex(value: string): string {
	const parts = value.split(/(\$[^$]*\$)/g);
	return parts
		.map((part) =>
			part.startsWith('$') && part.endsWith('$') && part.length > 1
				? part
				: part.replace(SPECIAL, (c) => REPLACEMENTS[c] ?? c)
		)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

/** „Juan M. Maldacena“ → „Maldacena, Juan M.“ (Kollektive bleiben in geschweiften Klammern). */
export function bibtexAuthor(name: string): string {
	const clean = name.replace(/\s+/g, ' ').trim();
	if (/collaboration|consortium|group|team/i.test(clean)) return `{${escapeBibtex(clean)}}`;
	if (clean.includes(',')) return escapeBibtex(clean);
	const parts = clean.split(' ');
	if (parts.length === 1) return escapeBibtex(clean);
	const last = parts.pop() as string;
	return `${escapeBibtex(last)}, ${escapeBibtex(parts.join(' '))}`;
}

function asciiFold(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/ß/g, 'ss')
		.replace(/[^A-Za-z0-9]/g, '');
}

const STOPWORDS = new Set([
	'a',
	'an',
	'the',
	'on',
	'of',
	'in',
	'for',
	'and',
	'to',
	'with',
	'der',
	'die',
	'das'
]);

/** Zitierschlüssel: Nachname der Erstautor:in + Jahr + erstes Titelwort, z. B. `maldacena1997large`. */
export function bibtexKey(input: Pick<BibtexInput, 'title' | 'authors' | 'publishedAt'>): string {
	const first = input.authors[0]?.replace(/\s+/g, ' ').trim() ?? '';
	const lastName = first.includes(',') ? first.split(',')[0] : first.split(' ').pop();
	const author = asciiFold(lastName ?? '').toLowerCase() || 'anon';
	const word =
		input.title
			.replace(/\$[^$]*\$/g, ' ')
			.split(/[^\p{L}\p{N}]+/u)
			.map((w) => asciiFold(w).toLowerCase())
			.find((w) => w.length > 0 && !STOPWORDS.has(w)) ?? 'paper';
	return `${author}${input.publishedAt.getUTCFullYear()}${word}`;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toBibtex(input: BibtexInput, key: string = bibtexKey(input)): string {
	const isPreprint = Boolean(input.arxivId) && !input.journal;
	const type = input.journal ? 'article' : 'misc';
	const fields: Array<[string, string]> = [
		['title', `{${escapeBibtex(input.title)}}`],
		['author', input.authors.map(bibtexAuthor).join(' and ')],
		['year', String(input.publishedAt.getUTCFullYear())],
		['month', MONTHS[input.publishedAt.getUTCMonth()] as string]
	];
	if (input.journal) fields.push(['journal', escapeBibtex(input.journal)]);
	if (input.doi) fields.push(['doi', input.doi]);
	if (input.arxivId) {
		fields.push(['eprint', input.arxivId], ['archiveprefix', 'arXiv']);
		if (input.primaryCategory) fields.push(['primaryclass', input.primaryCategory]);
	}
	if (input.pmid) fields.push(['pmid', input.pmid]);
	if (input.url) fields.push(['url', input.url]);
	if (isPreprint) fields.push(['note', 'Preprint']);

	const body = fields
		.filter(([, v]) => v.length > 0)
		// Monat ist ein BibTeX-Makro und steht ohne Klammern.
		.map(([k, v]) => (k === 'month' ? `  ${k} = ${v}` : `  ${k} = {${v}}`))
		.join(',\n');
	return `@${type}{${key},\n${body}\n}\n`;
}

/** Mehrere Einträge mit eindeutigen Schlüsseln (Kollisionen erhalten a, b, c …). */
export function toBibtexFile(entries: readonly BibtexInput[]): string {
	const used = new Map<string, number>();
	return entries
		.map((entry) => {
			const base = bibtexKey(entry);
			const n = used.get(base) ?? 0;
			used.set(base, n + 1);
			const key = n === 0 ? base : `${base}${String.fromCharCode(97 + ((n - 1) % 26))}`;
			return toBibtex(entry, key);
		})
		.join('\n');
}
