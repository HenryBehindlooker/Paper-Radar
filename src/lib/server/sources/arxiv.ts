import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { SourceHttpError, SourceParseError } from './errors';
import type { HttpClient } from './http';
import {
	arxivIdFromDoi,
	collapseWhitespace,
	nonEmpty,
	normalizeArxivId,
	normalizeDoi,
	normalizeOrcid,
	parseDate
} from './normalize';
import type {
	IdRef,
	IdType,
	NormalizedPaper,
	PaperSource,
	QueryKind,
	SearchOptions,
	SourceQuery
} from './types';
import { needsQuotes, parseWebsearch, renderWebsearch, type WebsearchTerm } from './websearch';

/**
 * arXiv-Adapter.
 *  - Suche/Backfill: Atom-API `https://export.arxiv.org/api/query`
 *  - Tägliche Neuerscheinungen: RSS `https://rss.arxiv.org/rss/<cat>[+<cat>…]`
 * Limit laut Nutzungsbedingungen: max. 1 Request alle 3 s, eine Verbindung –
 * gilt für API und RSS gemeinsam, daher teilen sich beide denselben HttpClient/Limiter.
 */

export const ARXIV_API_URL = 'https://export.arxiv.org/api/query';
export const ARXIV_RSS_URL = 'https://rss.arxiv.org/rss/';

/** Seitengröße der API (Doku: max. 2000 pro Request; wir bleiben klein). */
const PAGE_SIZE = 100;
const DEFAULT_MAX_RESULTS = 300;
/** Kategorien pro RSS-Request (Doku: kombinierte Feeds bis 2000 Einträge). */
const RSS_CATEGORIES_PER_REQUEST = 10;

const ARXIV_CATEGORY = /^[a-z-]+(?:\.[A-Za-z-]+)?$/;

export function isArxivCategory(value: string): boolean {
	return ARXIV_CATEGORY.test(value);
}

const xml = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
	isArray: (name) => ['entry', 'author', 'category', 'link', 'item'].includes(name)
});

// ---------------------------------------------------------------------------
// Parsing (reine Funktionen)
// ---------------------------------------------------------------------------

type XmlNode = Record<string, unknown>;

/** Validiert und parst XML; wirft `SourceParseError` bei kaputten Dokumenten. */
function parseXml(body: string, what: string): XmlNode {
	const validation = XMLValidator.validate(body);
	if (validation !== true) {
		throw new SourceParseError('arxiv', `${what} ist kein gültiges XML: ${validation.err.msg}`);
	}
	try {
		return xml.parse(body) as XmlNode;
	} catch (error) {
		throw new SourceParseError('arxiv', `${what} ist kein gültiges XML`, { cause: error });
	}
}

function text(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	if (value && typeof value === 'object' && '#text' in value) {
		return text((value as XmlNode)['#text']);
	}
	return undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function attr(node: unknown, name: string): string | undefined {
	if (node && typeof node === 'object') {
		const v = (node as XmlNode)[`@_${name}`];
		return typeof v === 'string' ? v : undefined;
	}
	return undefined;
}

function uniqueCategories(values: Array<string | undefined>): string[] {
	const out: string[] = [];
	for (const v of values) {
		if (v && isArxivCategory(v) && !out.includes(v)) out.push(v);
	}
	return out;
}

function firstDoi(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	for (const candidate of raw.split(/\s+/)) {
		const doi = normalizeDoi(candidate);
		// DataCite-DOIs von arXiv identifizieren das Preprint selbst, nicht die Verlagsversion.
		if (doi && !arxivIdFromDoi(doi)) return doi;
	}
	return undefined;
}

export interface ArxivAtomResult {
	papers: NormalizedPaper[];
	totalResults: number;
	/** Fehlermeldungen, die die API als Atom-Einträge liefert (älteres Verhalten). */
	errors: string[];
}

export function parseArxivAtom(body: string): ArxivAtomResult {
	const doc = parseXml(body, 'Atom-Antwort');
	const feed = doc.feed as XmlNode | undefined;
	if (!feed) throw new SourceParseError('arxiv', 'Atom-Antwort ohne <feed>');

	const totalResults = Number(text(feed['opensearch:totalResults']) ?? '0') || 0;
	const papers: NormalizedPaper[] = [];
	const errors: string[] = [];

	for (const entry of asArray(feed.entry as XmlNode[] | undefined)) {
		const idUrl = text(entry.id) ?? '';
		if (/\/api\/errors/.test(idUrl)) {
			errors.push(collapseWhitespace(text(entry.summary) ?? 'unbekannter Fehler'));
			continue;
		}
		const arxivId = normalizeArxivId(idUrl);
		const title = collapseWhitespace(text(entry.title) ?? '');
		const published = parseDate(text(entry.published));
		if (!arxivId || !title || !published) continue;

		const categories = uniqueCategories([
			attr(entry['arxiv:primary_category'], 'term'),
			...asArray(entry.category as XmlNode[] | undefined).map((c) => attr(c, 'term'))
		]);
		const abstract = nonEmpty(collapseWhitespace(text(entry.summary) ?? ''));
		const doi = firstDoi(text(entry['arxiv:doi']));
		papers.push({
			source: 'arxiv',
			ids: { arxivId, ...(doi ? { doi } : {}) },
			title,
			...(abstract ? { abstract } : {}),
			// arXiv-Metadaten inkl. Abstracts stehen unter CC0 (API Terms of Use).
			abstractLicenseOk: true,
			authors: asArray(entry.author as XmlNode[] | undefined)
				.map((a) => collapseWhitespace(text(a.name) ?? ''))
				.filter(Boolean)
				.map((name) => ({ name })),
			categories,
			publishedAt: published,
			updatedAt: parseDate(text(entry.updated)) ?? published,
			landingUrl: `https://arxiv.org/abs/${arxivId}`,
			pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
			...(nonEmpty(text(entry['arxiv:journal_ref']))
				? { journal: collapseWhitespace(text(entry['arxiv:journal_ref']) as string) }
				: {})
		});
	}
	return { papers, totalResults, errors };
}

export type ArxivAnnounceType = 'new' | 'cross' | 'replace' | 'replace-cross';

export interface ArxivRssItem {
	paper: NormalizedPaper;
	announceType: ArxivAnnounceType | string;
	version?: number;
}

export function parseArxivRss(body: string): ArxivRssItem[] {
	const doc = parseXml(body, 'RSS-Antwort');
	const channel = (doc.rss as XmlNode | undefined)?.channel as XmlNode | undefined;
	if (!channel) throw new SourceParseError('arxiv', 'RSS-Antwort ohne <channel>');

	const items: ArxivRssItem[] = [];
	for (const item of asArray(channel.item as XmlNode[] | undefined)) {
		const description = text(item.description) ?? '';
		const guid = text(item.guid) ?? '';
		const head = /^arXiv:(\S+)\s+Announce Type:\s*(\S+)/i.exec(description.trim());
		const rawId = head?.[1] ?? guid;
		const arxivId = normalizeArxivId(rawId) ?? normalizeArxivId(text(item.link) ?? '');
		const title = collapseWhitespace(text(item.title) ?? '');
		const announced = parseDate(text(item.pubDate));
		if (!arxivId || !title || !announced) continue;

		const abstractMatch = /Abstract:\s*([\s\S]*)$/i.exec(description);
		const abstract = nonEmpty(collapseWhitespace(abstractMatch?.[1] ?? ''));
		const creators = text(item['dc:creator']) ?? '';
		const doi = firstDoi(text(item['arxiv:DOI']));
		const journal = nonEmpty(collapseWhitespace(text(item['arxiv:journal_reference']) ?? ''));
		const versionMatch = /v(\d+)$/.exec(rawId);

		items.push({
			announceType: (
				text(item['arxiv:announce_type']) ??
				head?.[2] ??
				'new'
			).toLowerCase() as ArxivAnnounceType,
			...(versionMatch?.[1] ? { version: Number(versionMatch[1]) } : {}),
			paper: {
				source: 'arxiv',
				ids: { arxivId, ...(doi ? { doi } : {}) },
				title,
				...(abstract ? { abstract } : {}),
				abstractLicenseOk: true,
				authors: creators
					.split(/,\s*/)
					.map((name) => collapseWhitespace(name))
					.filter(Boolean)
					.map((name) => ({ name })),
				categories: uniqueCategories(asArray(item.category).map((c) => text(c))),
				// Der RSS-Feed nennt nur das Ankündigungsdatum.
				publishedAt: announced,
				updatedAt: announced,
				landingUrl: `https://arxiv.org/abs/${arxivId}`,
				pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
				...(journal ? { journal } : {})
			}
		});
	}
	return items;
}

/** Erkennt die Fehlerantwort des RSS-Dienstes (z. B. unbekannte Kategorie). */
export function parseArxivRssError(body: string): string | undefined {
	try {
		const channel = ((xml.parse(body) as XmlNode).rss as XmlNode | undefined)?.channel as
			XmlNode | undefined;
		const title = text(channel?.title) ?? '';
		if (/^Feed error/i.test(title)) return collapseWhitespace(text(channel?.description) ?? title);
	} catch {
		// kein RSS
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Abfrage-Übersetzung
// ---------------------------------------------------------------------------

function quote(value: string): string {
	return `"${value.replace(/"/g, '')}"`;
}

const arxivDialect = {
	term: (t: WebsearchTerm) => (needsQuotes(t) ? `all:${quote(t.text)}` : `all:${t.text}`),
	and: 'AND',
	or: 'OR',
	andNot: 'ANDNOT'
};

/** „Yang, Rui“ → „Rui Yang“; sonst unverändert. */
function displayName(value: string): string {
	const m = /^([^,]+),\s*(.+)$/.exec(value.trim());
	return collapseWhitespace(m ? `${m[2]} ${m[1]}` : value);
}

/** arXiv-Datumsfilter: `[YYYYMMDDHHMM TO YYYYMMDDHHMM]` in GMT. */
export function arxivDateRange(since: Date, until: Date): string {
	const fmt = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 12);
	return `submittedDate:[${fmt(since)} TO ${fmt(until)}]`;
}

/** Baut `search_query` oder `null`, wenn die Abfrage für arXiv nicht ausdrückbar ist. */
export function buildArxivQuery(query: SourceQuery, since: Date, until: Date): string | null {
	let core: string | null = null;
	switch (query.kind) {
		case 'keyword':
			core = renderWebsearch(parseWebsearch(query.value), arxivDialect);
			break;
		case 'category':
			core = isArxivCategory(query.value.trim()) ? `cat:${query.value.trim()}` : null;
			break;
		case 'author':
			// arXiv kennt keine ORCID-Suche.
			core = normalizeOrcid(query.value) ? null : `au:${quote(displayName(query.value))}`;
			break;
	}
	if (!core) return null;
	return `(${core}) AND ${arxivDateRange(since, until)}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ArxivSourceOptions {
	http: HttpClient;
	now?: () => Date;
	/** Treffer pro API-Seite (Standard 100, arXiv erlaubt bis 2000). */
	pageSize?: number;
}

export interface DailyAnnouncementOptions {
	/** Auch ersetzte Versionen (`replace`, `replace-cross`) liefern. Standard: nein. */
	includeReplacements?: boolean;
}

export class ArxivSource implements PaperSource {
	readonly name = 'arxiv' as const;
	readonly supportedQueryKinds: ReadonlySet<QueryKind> = new Set(['keyword', 'category', 'author']);
	readonly supportedIdTypes: ReadonlySet<IdType> = new Set(['arxiv']);
	readonly #http: HttpClient;
	readonly #now: () => Date;
	readonly #pageSize: number;

	constructor(options: ArxivSourceOptions) {
		this.#http = options.http;
		this.#now = options.now ?? (() => new Date());
		this.#pageSize = Math.min(2000, Math.max(1, options.pageSize ?? PAGE_SIZE));
	}

	async search(
		query: SourceQuery,
		since: Date,
		options: SearchOptions = {}
	): Promise<NormalizedPaper[]> {
		const until = options.until ?? this.#now();
		const searchQuery = buildArxivQuery(query, since, until);
		if (!searchQuery) return [];
		const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;

		const papers: NormalizedPaper[] = [];
		const seen = new Set<string>();
		for (let start = 0; start < maxResults; start += this.#pageSize) {
			const pageSize = Math.min(this.#pageSize, maxResults - start);
			const params = new URLSearchParams({
				search_query: searchQuery,
				start: String(start),
				max_results: String(pageSize),
				sortBy: 'submittedDate',
				sortOrder: 'descending'
			});
			const result = await this.#fetchAtom(`${ARXIV_API_URL}?${params}`);
			if (result.errors.length > 0) {
				throw new SourceHttpError('arxiv', 400, ARXIV_API_URL, result.errors.join('; '));
			}
			for (const paper of result.papers) {
				// Die API kann Einträge seitenübergreifend wiederholen.
				if (!seen.has(paper.ids.arxivId as string)) {
					seen.add(paper.ids.arxivId as string);
					papers.push(paper);
				}
			}
			if (result.papers.length < pageSize || start + pageSize >= result.totalResults) break;
		}
		return papers;
	}

	async getById(id: IdRef): Promise<NormalizedPaper[]> {
		if (id.type !== 'arxiv') return [];
		const arxivId = normalizeArxivId(id.value);
		if (!arxivId) return [];
		const params = new URLSearchParams({ id_list: arxivId, max_results: '1' });
		const result = await this.#fetchAtom(`${ARXIV_API_URL}?${params}`);
		return result.papers.filter((p) => p.ids.arxivId === arxivId);
	}

	/**
	 * Neuerscheinungen des letzten Ankündigungstags für mehrere Kategorien.
	 * Kategorien werden zu kombinierten Feeds gebündelt (`cs.DL+math.AG`),
	 * damit möglichst wenige Requests nötig sind. Ergebnis ist nach arXiv-ID dedupliziert.
	 */
	async fetchDailyAnnouncements(
		categories: readonly string[],
		options: DailyAnnouncementOptions = {}
	): Promise<ArxivRssItem[]> {
		const valid = [...new Set(categories.map((c) => c.trim()))].filter(isArxivCategory);
		const byId = new Map<string, ArxivRssItem>();
		for (let i = 0; i < valid.length; i += RSS_CATEGORIES_PER_REQUEST) {
			const chunk = valid.slice(i, i + RSS_CATEGORIES_PER_REQUEST);
			const url = `${ARXIV_RSS_URL}${chunk.join('+')}`;
			const res = await this.#http.get(url);
			if (res.status !== 200) {
				throw new SourceHttpError(
					'arxiv',
					res.status,
					url,
					parseArxivRssError(res.body) ?? res.body.slice(0, 500)
				);
			}
			for (const item of parseArxivRss(res.body)) {
				const isReplacement = item.announceType.startsWith('replace');
				if (isReplacement && !options.includeReplacements) continue;
				const key = item.paper.ids.arxivId as string;
				if (!byId.has(key)) byId.set(key, item);
			}
		}
		return [...byId.values()];
	}

	async #fetchAtom(url: string): Promise<ArxivAtomResult> {
		const res = await this.#http.get(url);
		if (res.status !== 200) throw new SourceHttpError('arxiv', res.status, url, res.body);
		return parseArxivAtom(res.body);
	}
}
