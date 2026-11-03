/**
 * Parser für die Postgres-`websearch_to_tsquery`-Syntax, damit Keyword-Abos
 * in die Abfragesprachen der Quellen übersetzt werden können.
 *
 * Unterstützt wie Postgres:
 *  - Wörter ohne Anführungszeichen → UND-verknüpft
 *  - "Phrase in Anführungszeichen"
 *  - `or` (beliebige Schreibweise) → ODER; bindet stärker als das implizite UND
 *  - `-wort` / `-"phrase"` → Ausschluss
 * Übrige Satzzeichen werden ignoriert.
 */

export interface WebsearchTerm {
	text: string;
	phrase: boolean;
	negated: boolean;
}

/** Konjunktion (UND) von Disjunktionen (ODER). */
export type WebsearchQuery = WebsearchTerm[][];

interface Token {
	type: 'term' | 'or';
	term?: WebsearchTerm;
}

/** Entfernt Zeichen, die in Abfragesprachen der Quellen Syntax wären. */
function sanitizeWord(word: string): string {
	return word.replace(/[^\p{L}\p{N}\-_.'+]/gu, ' ').trim();
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i] ?? '';
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		let negated = false;
		if (ch === '-') {
			negated = true;
			i++;
		}
		if (input[i] === '"') {
			const end = input.indexOf('"', i + 1);
			const raw = input.slice(i + 1, end === -1 ? undefined : end);
			i = end === -1 ? input.length : end + 1;
			const text = raw.split(/\s+/).map(sanitizeWord).filter(Boolean).join(' ');
			if (text) tokens.push({ type: 'term', term: { text, phrase: text.includes(' '), negated } });
			continue;
		}
		let j = i;
		while (j < input.length && !/\s/.test(input[j] ?? '') && input[j] !== '"') j++;
		const word = input.slice(i, j);
		i = j;
		if (!negated && word.toLowerCase() === 'or') {
			tokens.push({ type: 'or' });
			continue;
		}
		// Innerhalb eines Worts trennen Satzzeichen weitere Wörter (wie Postgres).
		const parts = sanitizeWord(word).split(/\s+/).filter(Boolean);
		if (parts.length === 1 && parts[0]) {
			tokens.push({ type: 'term', term: { text: parts[0], phrase: false, negated } });
		} else if (parts.length > 1) {
			tokens.push({ type: 'term', term: { text: parts.join(' '), phrase: true, negated } });
		}
	}
	return tokens;
}

export function parseWebsearch(input: string): WebsearchQuery {
	const tokens = tokenize(input);
	const groups: WebsearchQuery = [];
	let pendingOr = false;
	for (const token of tokens) {
		if (token.type === 'or') {
			pendingOr = groups.length > 0;
			continue;
		}
		const term = token.term as WebsearchTerm;
		const last = groups[groups.length - 1];
		if (pendingOr && last) last.push(term);
		else groups.push([term]);
		pendingOr = false;
	}
	return groups;
}

export interface QueryDialect {
	/** Formatiert einen positiven Begriff (Wort oder Phrase). */
	term(term: WebsearchTerm): string;
	and: string;
	or: string;
	/** Operator für Ausschlüsse, z. B. `ANDNOT` (arXiv) oder `NOT` (Europe PMC). */
	andNot: string;
}

/**
 * Übersetzt eine geparste Abfrage in einen Quell-Dialekt. Ausschlüsse innerhalb
 * einer ODER-Gruppe lassen sich in den Quellen nicht ausdrücken und werden
 * verworfen (die lokale Volltextsuche filtert später exakt).
 * Gibt `null` zurück, wenn keine positiven Begriffe übrig bleiben.
 */
export function renderWebsearch(query: WebsearchQuery, dialect: QueryDialect): string | null {
	const positives: string[] = [];
	const negatives: string[] = [];
	for (const group of query) {
		if (group.length === 1 && group[0]?.negated) {
			negatives.push(dialect.term(group[0]));
			continue;
		}
		const alts = group.filter((t) => !t.negated).map((t) => dialect.term(t));
		if (alts.length === 0) continue;
		positives.push(alts.length === 1 ? (alts[0] as string) : `(${alts.join(` ${dialect.or} `)})`);
	}
	if (positives.length === 0) return null;
	let result = positives.join(` ${dialect.and} `);
	for (const neg of negatives) result += ` ${dialect.andNot} ${neg}`;
	return result;
}

/** Phrasen und Begriffe mit Satzzeichen (z. B. `trans-cleavage`) werden gequotet. */
export function needsQuotes(term: WebsearchTerm): boolean {
	return term.phrase || /[^\p{L}\p{N}]/u.test(term.text);
}
