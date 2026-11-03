/**
 * Reine Hilfsfunktionen zur Normalisierung von IDs, Text und Datumsangaben.
 */

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	lsquo: '‘',
	rsquo: '’',
	ldquo: '“',
	rdquo: '”',
	times: '×',
	plusmn: '±',
	deg: '°',
	micro: 'µ',
	alpha: 'α',
	beta: 'β',
	gamma: 'γ',
	delta: 'δ',
	kappa: 'κ',
	lambda: 'λ',
	mu: 'μ',
	sigma: 'σ'
};

/** Dekodiert HTML-Entities (benannt, dezimal, hexadezimal). Unbekannte bleiben stehen. */
export function decodeEntities(input: string): string {
	return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const code =
				entity[1] === 'x' || entity[1] === 'X'
					? parseInt(entity.slice(2), 16)
					: parseInt(entity.slice(1), 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
			try {
				return String.fromCodePoint(code);
			} catch {
				return match;
			}
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/** Fasst Leerraum (inkl. Zeilenumbrüche) zu einzelnen Leerzeichen zusammen. */
export function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, ' ').trim();
}

const BLOCK_TAG =
	/<\/?(?:[a-z]+:)?(?:p|div|br|h[1-6]|title|sec|li|ul|ol|list|list-item|abstract|blockquote|table|tr)\b[^>]*>/gi;

/**
 * Entfernt HTML-/JATS-Markup und liefert reinen Text.
 * Absätze werden durch eine Leerzeile getrennt; eine einleitende Überschrift
 * „Abstract“ wird entfernt. LaTeX bleibt unverändert.
 */
export function stripMarkup(input: string): string {
	const withBreaks = input.replace(BLOCK_TAG, '\n\n');
	const noTags = withBreaks.replace(/<[^>]+>/g, '');
	const decoded = decodeEntities(noTags);
	const paragraphs = decoded
		.split(/\n\s*\n/)
		.map((p) => collapseWhitespace(p))
		.filter((p) => p.length > 0);
	if (paragraphs.length > 1 && /^abstract[.:]?$/i.test(paragraphs[0] ?? '')) {
		paragraphs.shift();
	}
	return paragraphs.join('\n\n');
}

/** Für Titel: Markup entfernen und in eine Zeile bringen. */
export function cleanTitle(input: string): string {
	return collapseWhitespace(stripMarkup(input));
}

/** Leere/whitespace-only Strings → `undefined`. */
export function nonEmpty(input: string | null | undefined): string | undefined {
	if (input === null || input === undefined) return undefined;
	const trimmed = input.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Identifikatoren
// ---------------------------------------------------------------------------

const NEW_ARXIV_ID = /^(\d{4}\.\d{4,5})(v\d+)?$/;
// Altes Schema: archive(.SUBJ)?/YYMMNNN, z. B. hep-th/9711200 oder math.AG/0501001
const OLD_ARXIV_ID = /^([a-z]+(?:-[a-z]+)?)(\.[a-z]{2})?\/(\d{7})(v\d+)?$/i;

/**
 * Neues Schema (seit April 2007): `YYMM.NNNN`, ab Januar 2015 `YYMM.NNNNN`.
 * https://info.arxiv.org/help/arxiv_identifier.html
 */
function isValidNewArxivId(id: string): boolean {
	const [yymm = '', seq = ''] = id.split('.');
	const yy = Number(yymm.slice(0, 2));
	const mm = Number(yymm.slice(2, 4));
	if (mm < 1 || mm > 12) return false;
	if (yy < 7 || (yy === 7 && mm < 4)) return false;
	return yy >= 15 ? seq.length === 5 : seq.length === 4;
}

/**
 * Normalisiert eine arXiv-ID: entfernt URL-/`arXiv:`-Präfix und Versionssuffix.
 * Alte IDs mit Subject-Class (`math.AG/0501001`) werden auf das Archiv reduziert
 * (`math/0501001`), da dies die kanonische Form ist.
 * Gibt `null` zurück, wenn kein gültiges Format vorliegt.
 */
export function normalizeArxivId(input: string): string | null {
	let s = input.trim();
	s = s.replace(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\//i, '');
	s = s.replace(/\.pdf$/i, '');
	s = s.replace(/^arxiv:/i, '');
	s = s.replace(/^oai:arxiv\.org:/i, '');
	const neu = NEW_ARXIV_ID.exec(s);
	if (neu?.[1]) return isValidNewArxivId(neu[1]) ? neu[1] : null;
	const old = OLD_ARXIV_ID.exec(s);
	if (old?.[1] && old[3]) return `${old[1].toLowerCase()}/${old[3]}`;
	return null;
}

/** Versionsnummer aus einer arXiv-ID (`2103.00020v2` → 2), sonst `undefined`. */
export function arxivVersion(input: string): number | undefined {
	const m = /v(\d+)$/.exec(input.trim());
	return m?.[1] ? Number(m[1]) : undefined;
}

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/** Normalisiert eine DOI (Präfixe entfernen, kleinschreiben). `null`, wenn ungültig. */
export function normalizeDoi(input: string): string | null {
	let s = input.trim();
	s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
	s = s.replace(/^doi:\s*/i, '');
	try {
		if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
	} catch {
		// unverändert lassen
	}
	s = s.toLowerCase();
	return DOI_PATTERN.test(s) ? s : null;
}

/**
 * arXiv vergibt DataCite-DOIs der Form `10.48550/arXiv.<id>`. Diese identifizieren
 * das Preprint selbst und werden als arXiv-ID statt als DOI geführt, damit eine
 * spätere Verlags-DOI das Preprint nicht verdrängt.
 */
export function arxivIdFromDoi(doi: string): string | null {
	const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi.trim());
	return m?.[1] ? normalizeArxivId(m[1]) : null;
}

/** Normalisiert eine ORCID inkl. Prüfziffer (ISO 7064 Mod 11-2). `null`, wenn ungültig. */
export function normalizeOrcid(input: string): string | null {
	const s = input
		.trim()
		.replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '')
		.replace(/^orcid:/i, '')
		.toUpperCase();
	if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(s)) return null;
	const digits = s.replace(/-/g, '');
	let total = 0;
	for (let i = 0; i < 15; i++) total = (total + Number(digits[i])) * 2;
	const remainder = total % 11;
	const result = (12 - remainder) % 11;
	const check = result === 10 ? 'X' : String(result);
	return digits[15] === check ? s : null;
}

/** `PMC123` / `123` → `PMC123`. `null`, wenn ungültig. */
export function normalizePmcid(input: string): string | null {
	const m = /^(?:pmc)?(\d+)$/i.exec(input.trim());
	return m?.[1] ? `PMC${m[1]}` : null;
}

/** Reine Ziffernfolge, sonst `null`. */
export function normalizePmid(input: string): string | null {
	const s = input.trim();
	return /^\d+$/.test(s) ? s : null;
}

/** OpenAlex-ID (URL oder Kurzform) → Kurzform mit großem Präfixbuchstaben. */
export function normalizeOpenAlexId(input: string): string | null {
	const s = input.trim().replace(/^https?:\/\/(?:api\.)?openalex\.org\/(?:\w+\/)?/i, '');
	const m = /^([WAISTKPFG])(\d+)$/i.exec(s);
	return m?.[1] && m[2] ? `${m[1].toUpperCase()}${m[2]}` : null;
}

// ---------------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------------

/** Parst ISO-Datum/Zeit oder RFC-2822-Datum; `undefined` bei ungültiger Eingabe. */
export function parseDate(input: string | null | undefined): Date | undefined {
	const s = nonEmpty(input);
	if (!s) return undefined;
	// Reines Datum als UTC-Mitternacht interpretieren.
	const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? undefined : new Date(ms);
}

/** Crossref-`date-parts` ([[YYYY, MM?, DD?]]) → UTC-Datum. */
export function dateFromParts(parts: ReadonlyArray<number | null> | undefined): Date | undefined {
	if (!parts || parts.length === 0) return undefined;
	const [year, month, day] = parts;
	if (typeof year !== 'number' || !Number.isFinite(year)) return undefined;
	return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
}

/** `YYYY-MM-DD` in UTC. */
export function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}
