import { SourceHttpError, SourceParseError } from './errors';
import type { HttpClient } from './http';
import {
	arxivIdFromDoi,
	cleanTitle,
	collapseWhitespace,
	isoDay,
	nonEmpty,
	normalizeDoi,
	normalizeOrcid,
	normalizePmcid,
	normalizePmid,
	parseDate,
	stripMarkup
} from './normalize';
import type {
	Author,
	IdRef,
	IdType,
	NormalizedPaper,
	PaperIds,
	PaperSource,
	QueryKind,
	SearchOptions,
	SourceQuery
} from './types';
import { needsQuotes, parseWebsearch, renderWebsearch, type WebsearchTerm } from './websearch';

/**
 * Europe-PMC-Adapter (REST, JSON, `resultType=core`).
 * Endpunkte laut OpenAPI-Spezifikation:
 * https://www.ebi.ac.uk/europepmc/webservices/rest/v3/api-docs
 */

export const EUROPEPMC_SEARCH_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

/** Laut OpenAPI max. 1000; kleinere Seiten halten einzelne Antworten überschaubar. */
const PAGE_SIZE = 100;
const DEFAULT_MAX_RESULTS = 500;

// ---------------------------------------------------------------------------
// Rohdaten (nur die genutzten Felder)
// ---------------------------------------------------------------------------

interface EpmcAuthor {
	fullName?: string;
	firstName?: string;
	lastName?: string;
	collectiveName?: string;
	authorId?: { type?: string; value?: string };
}

interface EpmcFullTextUrl {
	availabilityCode?: string;
	documentStyle?: string;
	url?: string;
}

export interface EpmcResult {
	id?: string;
	source?: string;
	pmid?: string;
	pmcid?: string;
	doi?: string;
	title?: string;
	abstractText?: string;
	authorList?: { author?: EpmcAuthor[] };
	firstPublicationDate?: string;
	firstIndexDate?: string;
	dateOfRevision?: string;
	license?: string;
	journalInfo?: { journal?: { title?: string } };
	bookOrReportDetails?: { publisher?: string };
	fullTextUrlList?: { fullTextUrl?: EpmcFullTextUrl[] };
}

export interface EpmcSearchResponse {
	hitCount?: number;
	nextCursorMark?: string;
	resultList?: { result?: EpmcResult[] };
	errCode?: number;
	errMsg?: string;
}

// ---------------------------------------------------------------------------
// Parsing (reine Funktionen)
// ---------------------------------------------------------------------------

/**
 * Abstracts dürfen nur übernommen werden, wenn eine offene Lizenz angegeben ist.
 * Europe PMC liefert z. B. `cc by`, `cc by-nc-nd`, `cc0`; fehlt die Angabe, gilt das
 * Urheberrecht des Verlags/der Autor:innen (EMBL-EBI Terms of Use).
 */
export function isOpenLicense(license: string | undefined): boolean {
	if (!license) return false;
	const l = license.trim().toLowerCase();
	return /^cc[\s-]?(?:0|by)\b/.test(l) || l === 'cc0' || /public domain/.test(l);
}

function authorName(a: EpmcAuthor): string | undefined {
	const combined = [a.firstName, a.lastName].filter(Boolean).join(' ');
	return nonEmpty(collapseWhitespace(combined || a.fullName || a.collectiveName || ''));
}

export function normalizeEuropePmcResult(r: EpmcResult): NormalizedPaper | null {
	const source = nonEmpty(r.source)?.toUpperCase();
	const id = nonEmpty(r.id);
	const title = cleanTitle(r.title ?? '');
	const published = parseDate(r.firstPublicationDate) ?? parseDate(r.firstIndexDate);
	if (!source || !id || !title || !published) return null;

	const ids: PaperIds = { europepmcId: `${source}/${id}` };
	const doi = r.doi ? normalizeDoi(r.doi) : null;
	const arxivId = doi ? arxivIdFromDoi(doi) : null;
	if (arxivId) ids.arxivId = arxivId;
	else if (doi) ids.doi = doi;
	const pmid = r.pmid ? normalizePmid(r.pmid) : null;
	if (pmid) ids.pmid = pmid;
	const pmcid = r.pmcid ? normalizePmcid(r.pmcid) : null;
	if (pmcid) ids.pmcid = pmcid;

	const authors: Author[] = [];
	for (const a of r.authorList?.author ?? []) {
		const name = authorName(a);
		if (!name) continue;
		const orcid =
			a.authorId?.type?.toUpperCase() === 'ORCID' && a.authorId.value
				? normalizeOrcid(a.authorId.value)
				: null;
		authors.push(orcid ? { name, orcid } : { name });
	}

	const abstract = r.abstractText ? nonEmpty(stripMarkup(r.abstractText)) : undefined;
	const pdf = (r.fullTextUrlList?.fullTextUrl ?? []).find(
		(u) =>
			u.documentStyle === 'pdf' &&
			(u.availabilityCode === 'OA' || u.availabilityCode === 'F') &&
			u.url
	);
	const journal = nonEmpty(r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher);

	return {
		source: 'europepmc',
		ids,
		title,
		...(abstract ? { abstract } : {}),
		abstractLicenseOk: abstract !== undefined && isOpenLicense(r.license),
		authors,
		categories: [],
		publishedAt: published,
		updatedAt: parseDate(r.dateOfRevision) ?? parseDate(r.firstIndexDate) ?? published,
		landingUrl: `https://europepmc.org/article/${source}/${encodeURIComponent(id)}`,
		...(pdf?.url ? { pdfUrl: pdf.url } : {}),
		...(journal ? { journal: collapseWhitespace(journal) } : {})
	};
}

export function parseEuropePmcSearch(body: string): {
	papers: NormalizedPaper[];
	hitCount: number;
	nextCursorMark?: string;
	resultCount: number;
} {
	let data: EpmcSearchResponse;
	try {
		data = JSON.parse(body) as EpmcSearchResponse;
	} catch (error) {
		throw new SourceParseError('europepmc', 'Antwort ist kein gültiges JSON', { cause: error });
	}
	if (data.errCode !== undefined) {
		throw new SourceParseError('europepmc', `Fehlerantwort ${data.errCode}: ${data.errMsg ?? ''}`);
	}
	const results = data.resultList?.result ?? [];
	const papers = results
		.map(normalizeEuropePmcResult)
		.filter((p): p is NormalizedPaper => p !== null);
	return {
		papers,
		hitCount: data.hitCount ?? 0,
		resultCount: results.length,
		...(data.nextCursorMark ? { nextCursorMark: data.nextCursorMark } : {})
	};
}

// ---------------------------------------------------------------------------
// Abfrage-Übersetzung
// ---------------------------------------------------------------------------

function quote(value: string): string {
	return `"${value.replace(/"/g, '')}"`;
}

const epmcDialect = {
	term: (t: WebsearchTerm) =>
		needsQuotes(t) ? `TITLE_ABS:${quote(t.text)}` : `TITLE_ABS:${t.text}`,
	and: 'AND',
	or: 'OR',
	andNot: 'NOT'
};

/**
 * Europe PMC indexiert Autoren als „Nachname Initialen“ (z. B. „Yang R“).
 * „Rui Yang“ / „Yang, Rui“ → „Yang R“; bereits passende Form bleibt erhalten.
 */
export function toEpmcAuthorName(input: string): string {
	const value = collapseWhitespace(input);
	const comma = /^([^,]+),\s*(.+)$/.exec(value);
	let last: string;
	let given: string[];
	if (comma?.[1] && comma[2]) {
		last = comma[1];
		given = comma[2].split(' ');
	} else {
		const parts = value.split(' ');
		const tail = parts[parts.length - 1] ?? '';
		if (parts.length > 1 && /^\p{Lu}{1,3}$/u.test(tail)) return value;
		last = parts.pop() ?? value;
		given = parts;
	}
	const initials = given
		.flatMap((g) => g.split('-'))
		.map((g) => g.replace(/\./g, '').charAt(0).toUpperCase())
		.join('');
	return initials ? `${last} ${initials}` : last;
}

export function buildEuropePmcQuery(query: SourceQuery, since: Date, until: Date): string | null {
	let core: string | null = null;
	switch (query.kind) {
		case 'keyword':
			core = renderWebsearch(parseWebsearch(query.value), epmcDialect);
			break;
		case 'author': {
			const orcid = normalizeOrcid(query.value);
			core = orcid ? `AUTHORID:${quote(orcid)}` : `AUTH:${quote(toEpmcAuthorName(query.value))}`;
			break;
		}
		case 'category':
			core = null;
			break;
	}
	if (!core) return null;
	// FIRST_IDATE = erstes Indexierungsdatum in Europe PMC → erfasst auch nachträglich
	// indexierte Arbeiten mit älterem Publikationsdatum.
	return `(${core}) AND FIRST_IDATE:[${isoDay(since)} TO ${isoDay(until)}]`;
}

function idQuery(id: IdRef): string | null {
	switch (id.type) {
		case 'doi': {
			const doi = normalizeDoi(id.value);
			return doi ? `DOI:${quote(doi)}` : null;
		}
		case 'pmid': {
			const pmid = normalizePmid(id.value);
			return pmid ? `EXT_ID:${pmid} AND SRC:MED` : null;
		}
		case 'pmcid': {
			const pmcid = normalizePmcid(id.value);
			return pmcid ? `PMCID:${pmcid}` : null;
		}
		case 'europepmc': {
			const m = /^([A-Z]{3})\/(\w+)$/i.exec(id.value.trim());
			return m?.[1] && m[2] ? `EXT_ID:${m[2]} AND SRC:${m[1].toUpperCase()}` : null;
		}
		default:
			return null;
	}
}

function matchesId(paper: NormalizedPaper, id: IdRef): boolean {
	switch (id.type) {
		case 'doi':
			return paper.ids.doi === normalizeDoi(id.value);
		case 'pmid':
			return paper.ids.pmid === normalizePmid(id.value);
		case 'pmcid':
			return paper.ids.pmcid === normalizePmcid(id.value);
		case 'europepmc':
			return paper.ids.europepmcId?.toUpperCase() === id.value.trim().toUpperCase();
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface EuropePmcSourceOptions {
	http: HttpClient;
	now?: () => Date;
	/** Treffer pro Seite (Standard 100, laut OpenAPI max. 1000). */
	pageSize?: number;
}

export class EuropePmcSource implements PaperSource {
	readonly name = 'europepmc' as const;
	readonly supportedQueryKinds: ReadonlySet<QueryKind> = new Set(['keyword', 'author']);
	readonly supportedIdTypes: ReadonlySet<IdType> = new Set(['doi', 'pmid', 'pmcid', 'europepmc']);
	readonly #http: HttpClient;
	readonly #now: () => Date;
	readonly #pageSize: number;

	constructor(options: EuropePmcSourceOptions) {
		this.#http = options.http;
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = Math.min(1000, Math.max(1, options.pageSize ?? PAGE_SIZE));
	}

	async search(
		query: SourceQuery,
		since: Date,
		options: SearchOptions = {}
	): Promise<NormalizedPaper[]> {
		const q = buildEuropePmcQuery(query, since, options.until ?? this.#now());
		if (!q) return [];
		const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
		const papers: NormalizedPaper[] = [];
		let cursor = '*';
		while (papers.length < maxResults) {
			const pageSize = Math.min(this.#pageSize, maxResults - papers.length);
			const page = await this.#search(q, pageSize, cursor);
			papers.push(...page.papers);
			if (page.resultCount < pageSize || !page.nextCursorMark || page.nextCursorMark === cursor) {
				break;
			}
			cursor = page.nextCursorMark;
		}
		return papers.slice(0, maxResults);
	}

	async getById(id: IdRef): Promise<NormalizedPaper[]> {
		const q = idQuery(id);
		if (!q) return [];
		const page = await this.#search(q, 10, '*');
		return page.papers.filter((p) => matchesId(p, id));
	}

	async #search(query: string, pageSize: number, cursorMark: string) {
		const params = new URLSearchParams({
			query,
			resultType: 'core',
			format: 'json',
			pageSize: String(pageSize),
			cursorMark
		});
		const url = `${EUROPEPMC_SEARCH_URL}?${params}`;
		const res = await this.#http.get(url, { Accept: 'application/json' });
		if (res.status !== 200) throw new SourceHttpError('europepmc', res.status, url, res.body);
		return parseEuropePmcSearch(res.body);
	}
}
