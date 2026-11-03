import {
	SourceBudgetExhaustedError,
	SourceDisabledError,
	SourceHttpError,
	SourceParseError
} from './errors';
import type { HttpClient, HttpResponse } from './http';
import {
	arxivIdFromDoi,
	cleanTitle,
	nonEmpty,
	normalizeDoi,
	normalizeOpenAlexId,
	normalizeOrcid,
	normalizePmcid,
	normalizePmid,
	parseDate
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
 * OpenAlex-Adapter – ausschließlich Einzelabrufe per ID/DOI (laut Doku kostenlos),
 * zur Anreicherung mit Zitationszahlen und Autoren-IDs.
 * Doku: https://help.openalex.org/api/get-single-entities/
 */

export const OPENALEX_API_URL = 'https://api.openalex.org';

/** Nur benötigte Felder abrufen (`select`). */
const WORK_FIELDS = [
	'id',
	'ids',
	'doi',
	'display_name',
	'publication_date',
	'updated_date',
	'authorships',
	'cited_by_count'
].join(',');

interface OpenAlexAuthorship {
	author?: { id?: string | null; display_name?: string | null; orcid?: string | null };
	raw_author_name?: string | null;
}

export interface OpenAlexWork {
	id?: string;
	doi?: string | null;
	ids?: { openalex?: string; doi?: string; pmid?: string; pmcid?: string };
	display_name?: string | null;
	publication_date?: string | null;
	updated_date?: string | null;
	authorships?: OpenAlexAuthorship[];
	cited_by_count?: number;
}

export interface OpenAlexUsage {
	/** Kosten dieses Requests in Credits (`X-RateLimit-Credits-Used`). */
	creditsUsed: number;
	/** Verbleibendes Tagesbudget (`X-RateLimit-Remaining`), falls gemeldet. */
	remaining?: number;
	/** Gesamtes Tagesbudget (`X-RateLimit-Limit`), falls gemeldet. */
	limit?: number;
	/** Sekunden bis zum Reset um Mitternacht UTC (`X-RateLimit-Reset`). */
	resetSeconds?: number;
	status: number;
}

function numberHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === '') return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

export function openAlexUsageFromResponse(response: HttpResponse): OpenAlexUsage {
	const h = response.headers;
	const remaining = numberHeader(h, 'x-ratelimit-remaining');
	const limit = numberHeader(h, 'x-ratelimit-limit');
	const resetSeconds = numberHeader(h, 'x-ratelimit-reset');
	return {
		creditsUsed: numberHeader(h, 'x-ratelimit-credits-used') ?? 0,
		...(remaining !== undefined ? { remaining } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(resetSeconds !== undefined ? { resetSeconds } : {}),
		status: response.status
	};
}

/**
 * `429` kann ein kurzfristiges Ratenlimit (Retry sinnvoll) oder ein erschöpftes
 * Tagesbudget sein (Retry sinnlos → sauber pausieren).
 */
export function isOpenAlexBudgetExhausted(response: HttpResponse): boolean {
	if (response.status !== 429) return false;
	if (/not_enough_credits/i.test(response.body)) return true;
	return numberHeader(response.headers, 'x-ratelimit-remaining') === 0;
}

/** Hook für den HttpClient: protokolliert Credits und bricht bei leerem Budget ab. */
export function createOpenAlexResponseHook(onUsage?: (usage: OpenAlexUsage) => void) {
	return (response: HttpResponse) => {
		onUsage?.(openAlexUsageFromResponse(response));
		if (isOpenAlexBudgetExhausted(response)) {
			throw new SourceBudgetExhaustedError('openalex', 'Tagesbudget an Credits aufgebraucht');
		}
	};
}

export function normalizeOpenAlexWork(work: OpenAlexWork): NormalizedPaper | null {
	const openalexId = normalizeOpenAlexId(work.id ?? work.ids?.openalex ?? '');
	const title = cleanTitle(work.display_name ?? '');
	const published = parseDate(work.publication_date);
	if (!openalexId || !title || !published) return null;

	const ids: PaperIds = { openalexId };
	const doi = normalizeDoi(work.doi ?? work.ids?.doi ?? '');
	const arxivId = doi ? arxivIdFromDoi(doi) : null;
	if (arxivId) ids.arxivId = arxivId;
	else if (doi) ids.doi = doi;
	const pmid = normalizePmid((work.ids?.pmid ?? '').replace(/^.*\//, ''));
	if (pmid) ids.pmid = pmid;
	const pmcid = normalizePmcid((work.ids?.pmcid ?? '').replace(/^.*\//, ''));
	if (pmcid) ids.pmcid = pmcid;

	const authors: Author[] = [];
	for (const a of work.authorships ?? []) {
		const name = nonEmpty(a.author?.display_name ?? a.raw_author_name ?? '');
		if (!name) continue;
		const author: Author = { name };
		const orcid = a.author?.orcid ? normalizeOrcid(a.author.orcid) : null;
		if (orcid) author.orcid = orcid;
		const authorId = a.author?.id ? normalizeOpenAlexId(a.author.id) : null;
		if (authorId) author.openalexId = authorId;
		authors.push(author);
	}

	return {
		source: 'openalex',
		ids,
		title,
		// Abstracts werden aus OpenAlex bewusst nicht übernommen.
		abstractLicenseOk: false,
		authors,
		categories: [],
		publishedAt: published,
		updatedAt: parseDate(work.updated_date) ?? published,
		landingUrl: doi ? `https://doi.org/${doi}` : `https://openalex.org/${openalexId}`,
		...(typeof work.cited_by_count === 'number' ? { citedByCount: work.cited_by_count } : {})
	};
}

function entityPath(id: IdRef): string | null {
	switch (id.type) {
		case 'doi': {
			const doi = normalizeDoi(id.value);
			return doi ? `doi:${encodeURIComponent(doi).replace(/%2F/gi, '/')}` : null;
		}
		case 'openalex':
			return normalizeOpenAlexId(id.value);
		case 'pmid': {
			const pmid = normalizePmid(id.value);
			return pmid ? `pmid:${pmid}` : null;
		}
		default:
			return null;
	}
}

export interface OpenAlexSourceOptions {
	http: HttpClient;
	/** Pflicht laut Projektvorgabe; ohne Key ist die Quelle deaktiviert. Nur serverseitig. */
	apiKey?: string;
}

export class OpenAlexSource implements PaperSource {
	readonly name = 'openalex' as const;
	readonly supportedQueryKinds: ReadonlySet<QueryKind> = new Set();
	readonly supportedIdTypes: ReadonlySet<IdType> = new Set(['doi', 'openalex', 'pmid']);
	readonly #http: HttpClient;
	readonly #apiKey?: string;

	constructor(options: OpenAlexSourceOptions) {
		this.#http = options.http;
		this.#apiKey = nonEmpty(options.apiKey);
	}

	get enabled(): boolean {
		return this.#apiKey !== undefined;
	}

	/** Listenabfragen verbrauchen Credits und werden hier bewusst nicht angeboten. */
	async search(): Promise<NormalizedPaper[]> {
		return [];
	}

	async getById(id: IdRef): Promise<NormalizedPaper[]> {
		if (!this.#apiKey) {
			throw new SourceDisabledError('openalex', 'OPENALEX_API_KEY ist nicht gesetzt');
		}
		const path = entityPath(id);
		if (!path) return [];
		const url = `${OPENALEX_API_URL}/works/${path}?select=${WORK_FIELDS}`;
		const res = await this.#http.get(url, {
			Accept: 'application/json',
			Authorization: `Bearer ${this.#apiKey}`
		});
		if (res.status === 404) return [];
		if (res.status !== 200) throw new SourceHttpError('openalex', res.status, url, res.body);
		let work: OpenAlexWork;
		try {
			work = JSON.parse(res.body) as OpenAlexWork;
		} catch (error) {
			throw new SourceParseError('openalex', 'Antwort ist kein gültiges JSON', { cause: error });
		}
		const paper = normalizeOpenAlexWork(work);
		return paper ? [paper] : [];
	}
}
