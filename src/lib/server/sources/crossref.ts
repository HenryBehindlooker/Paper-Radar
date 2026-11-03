import { SourceHttpError, SourceParseError } from './errors';
import type { HttpClient, HttpResponse } from './http';
import type { RateLimiter } from './rate-limiter';
import {
	arxivIdFromDoi,
	cleanTitle,
	collapseWhitespace,
	dateFromParts,
	nonEmpty,
	normalizeDoi,
	normalizeOrcid,
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
	QueryKind
} from './types';

/**
 * Crossref-Adapter – nur DOI-Lookup und Metadaten-Ergänzung (keine Abo-Suche).
 * Doku: https://www.crossref.org/documentation/retrieve-metadata/rest-api/
 */

export const CROSSREF_API_URL = 'https://api.crossref.org';

/** DOIs pro Listenabfrage (`filter=doi:…,doi:…`). */
const DOIS_PER_REQUEST = 20;

// ---------------------------------------------------------------------------
// Rohdaten (nur genutzte Felder)
// ---------------------------------------------------------------------------

interface CrossrefDate {
	'date-parts'?: Array<Array<number | null>>;
	'date-time'?: string;
}

interface CrossrefLicense {
	URL?: string;
	'content-version'?: string;
	start?: CrossrefDate;
	'delay-in-days'?: number;
}

interface CrossrefAuthor {
	given?: string;
	family?: string;
	name?: string;
	ORCID?: string;
}

export interface CrossrefWork {
	DOI?: string;
	title?: string[];
	abstract?: string;
	author?: CrossrefAuthor[];
	license?: CrossrefLicense[];
	'container-title'?: string[];
	'published-online'?: CrossrefDate;
	'published-print'?: CrossrefDate;
	posted?: CrossrefDate;
	published?: CrossrefDate;
	issued?: CrossrefDate;
	created?: CrossrefDate;
	indexed?: CrossrefDate;
	deposited?: CrossrefDate;
	subject?: string[];
}

// ---------------------------------------------------------------------------
// Lizenzprüfung
// ---------------------------------------------------------------------------

const OPEN_LICENSE_URL = /^https?:\/\/(?:www\.)?creativecommons\.org\/(?:licenses|publicdomain)\//i;

/**
 * Crossref: „Abstracts – Copyright held by publisher or author“. Ein Abstract wird nur
 * übernommen, wenn für die Verlagsversion (`vor`) bzw. ohne Versionsangabe
 * (`unspecified`) eine Creative-Commons-/Public-Domain-Lizenz gilt, die bereits begonnen hat.
 */
export function crossrefAbstractLicenseOk(work: CrossrefWork, now: Date): boolean {
	return (work.license ?? []).some((l) => {
		const version = l['content-version'] ?? 'unspecified';
		if (version !== 'vor' && version !== 'unspecified') return false;
		if (!l.URL || !OPEN_LICENSE_URL.test(l.URL.trim())) return false;
		const start = parseDate(l.start?.['date-time']) ?? dateFromParts(l.start?.['date-parts']?.[0]);
		if (!start) return true;
		const effective = start.getTime() + (l['delay-in-days'] ?? 0) * 86_400_000;
		return effective <= now.getTime();
	});
}

// ---------------------------------------------------------------------------
// Normalisierung (reine Funktionen)
// ---------------------------------------------------------------------------

function crossrefDate(d: CrossrefDate | undefined): Date | undefined {
	return parseDate(d?.['date-time']) ?? dateFromParts(d?.['date-parts']?.[0]);
}

export function normalizeCrossrefWork(work: CrossrefWork, now: Date): NormalizedPaper | null {
	const doi = work.DOI ? normalizeDoi(work.DOI) : null;
	const title = cleanTitle(work.title?.[0] ?? '');
	const published =
		crossrefDate(work['published-online']) ??
		crossrefDate(work['published-print']) ??
		crossrefDate(work.posted) ??
		crossrefDate(work.published) ??
		crossrefDate(work.issued) ??
		crossrefDate(work.created);
	if (!doi || !title || !published) return null;

	const ids: PaperIds = {};
	const arxivId = arxivIdFromDoi(doi);
	if (arxivId) ids.arxivId = arxivId;
	else ids.doi = doi;

	const authors: Author[] = [];
	for (const a of work.author ?? []) {
		const name = nonEmpty(
			collapseWhitespace([a.given, a.family].filter(Boolean).join(' ') || a.name || '')
		);
		if (!name) continue;
		const orcid = a.ORCID ? normalizeOrcid(a.ORCID) : null;
		authors.push(orcid ? { name, orcid } : { name });
	}

	const abstract = work.abstract ? nonEmpty(stripMarkup(work.abstract)) : undefined;
	const licenseOk = crossrefAbstractLicenseOk(work, now);
	const journal = nonEmpty(work['container-title']?.[0]);

	return {
		source: 'crossref',
		ids,
		title,
		// Ohne offene Lizenz wird der Abstract gar nicht erst weitergereicht.
		...(abstract && licenseOk ? { abstract } : {}),
		abstractLicenseOk: abstract !== undefined && licenseOk,
		authors,
		categories: [],
		publishedAt: published,
		updatedAt: crossrefDate(work.indexed) ?? crossrefDate(work.deposited) ?? published,
		landingUrl: `https://doi.org/${doi}`,
		...(journal ? { journal: cleanTitle(journal) } : {})
	};
}

/** Kodiert eine DOI für den URL-Pfad; `/` bleibt erhalten. */
export function encodeDoiPath(doi: string): string {
	return encodeURIComponent(doi).replace(/%2F/gi, '/');
}

/**
 * Liest Crossrefs Limit-Header (`x-rate-limit-limit`, `x-rate-limit-interval`,
 * `x-concurrency-limit`) und verschärft den Limiter entsprechend.
 */
export function applyCrossrefRateHeaders(limiter: RateLimiter, response: HttpResponse): void {
	const limit = Number(response.headers.get('x-rate-limit-limit'));
	const intervalRaw = response.headers.get('x-rate-limit-interval') ?? '';
	const interval = /^(\d+)s$/.exec(intervalRaw.trim());
	const concurrency = Number(response.headers.get('x-concurrency-limit'));
	const update: { minIntervalMs?: number; maxConcurrent?: number } = {};
	if (limit > 0 && interval?.[1]) update.minIntervalMs = (Number(interval[1]) * 1000) / limit;
	if (concurrency > 0) update.maxConcurrent = concurrency;
	limiter.update(update);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CrossrefSourceOptions {
	http: HttpClient;
	/** Kontaktadresse für den „polite pool“ (`mailto`-Parameter). */
	mailto?: string;
	now?: () => Date;
}

export class CrossrefSource implements PaperSource {
	readonly name = 'crossref' as const;
	/** Crossref dient nur der Anreicherung – keine Abo-Suche. */
	readonly supportedQueryKinds: ReadonlySet<QueryKind> = new Set();
	readonly supportedIdTypes: ReadonlySet<IdType> = new Set(['doi']);
	readonly #http: HttpClient;
	readonly #mailto?: string;
	readonly #now: () => Date;

	constructor(options: CrossrefSourceOptions) {
		this.#http = options.http;
		this.#mailto = nonEmpty(options.mailto);
		this.#now = options.now ?? (() => new Date());
	}

	async search(): Promise<NormalizedPaper[]> {
		return [];
	}

	async getById(id: IdRef): Promise<NormalizedPaper[]> {
		if (id.type !== 'doi') return [];
		const doi = normalizeDoi(id.value);
		if (!doi) return [];
		const url = this.#url(`/works/${encodeDoiPath(doi)}`);
		const res = await this.#http.get(url, { Accept: 'application/json' });
		if (res.status === 404) return [];
		if (res.status !== 200) throw new SourceHttpError('crossref', res.status, url, res.body);
		const work = parseMessage<CrossrefWork>(res.body);
		const paper = normalizeCrossrefWork(work, this.#now());
		return paper ? [paper] : [];
	}

	/**
	 * Lädt mehrere DOIs gebündelt über `filter=doi:…` (effizienter als Einzelabrufe).
	 * Unbekannte DOIs fehlen einfach im Ergebnis.
	 */
	async getByDois(dois: readonly string[]): Promise<NormalizedPaper[]> {
		const unique = [
			...new Set(dois.map((d) => normalizeDoi(d)).filter((d): d is string => d !== null))
		];
		const papers: NormalizedPaper[] = [];
		for (let i = 0; i < unique.length; i += DOIS_PER_REQUEST) {
			const chunk = unique.slice(i, i + DOIS_PER_REQUEST);
			const url = this.#url('/works', {
				filter: chunk.map((d) => `doi:${d}`).join(','),
				rows: String(chunk.length)
			});
			const res = await this.#http.get(url, { Accept: 'application/json' });
			if (res.status !== 200) throw new SourceHttpError('crossref', res.status, url, res.body);
			const { items = [] } = parseMessage<{ items?: CrossrefWork[] }>(res.body);
			for (const item of items) {
				const paper = normalizeCrossrefWork(item, this.#now());
				if (paper) papers.push(paper);
			}
		}
		return papers;
	}

	#url(path: string, params: Record<string, string> = {}): string {
		const search = new URLSearchParams(params);
		if (this.#mailto) search.set('mailto', this.#mailto);
		const qs = search.toString();
		return `${CROSSREF_API_URL}${path}${qs ? `?${qs}` : ''}`;
	}
}

function parseMessage<T>(body: string): T {
	try {
		const data = JSON.parse(body) as { status?: string; message?: T };
		if (data.status !== 'ok' || data.message === undefined) {
			throw new Error(`unerwarteter Status ${String(data.status)}`);
		}
		return data.message;
	} catch (error) {
		throw new SourceParseError('crossref', 'Antwort ließ sich nicht lesen', { cause: error });
	}
}
