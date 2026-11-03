import type { IdType, NormalizedPaper, PaperIds, SourceName } from '../sources/types';

/**
 * Reine Funktionen für Dedup/Merge von Paper-Datensätzen.
 *
 * Regeln:
 *  - Titel, Autoren und Landing-URL kommen aus der Quelle mit der höchsten Priorität
 *    (Verlagsversion vor Preprint): crossref > europepmc > arxiv > openalex.
 *    Bei gleicher Quelle gewinnt der neuere Stand (z. B. neue arXiv-Version).
 *  - Abstract: ein lizenzrechtlich anzeigbarer Abstract schlägt einen nicht anzeigbaren;
 *    sonst bleibt der vorhandene (Aktualisierung nur durch dieselbe Quelle).
 *  - Veröffentlichungsdatum: das früheste (Preprint zählt), Änderungsdatum: das späteste.
 *  - Kategorien und Quellen: Vereinigung.
 */

export const SOURCE_PRIORITY: Record<SourceName, number> = {
	crossref: 4,
	europepmc: 3,
	arxiv: 2,
	openalex: 1
};

/** Gespeicherte bzw. eingehende Felder eines Papers (ohne IDs und Autoren). */
export interface PaperFacet {
	metadataSource: SourceName;
	title: string;
	abstract: string | null;
	abstractLicenseOk: boolean;
	abstractSource: SourceName | null;
	sources: SourceName[];
	categories: string[];
	journal: string | null;
	landingUrl: string;
	pdfUrl: string | null;
	publishedAt: Date;
	sourceUpdatedAt: Date;
	citedByCount: number | null;
	/** Anzahl gespeicherter Autor:innen (nur zur Entscheidung, ob ersetzt wird). */
	authorCount: number;
}

export interface MergeResult {
	facet: PaperFacet;
	/** Autorenliste der eingehenden Seite übernehmen? */
	takeIncomingAuthors: boolean;
}

export function facetFromPaper(paper: NormalizedPaper): PaperFacet {
	return {
		metadataSource: paper.source,
		title: paper.title,
		abstract: paper.abstract ?? null,
		abstractLicenseOk: paper.abstract !== undefined && paper.abstractLicenseOk,
		abstractSource: paper.abstract !== undefined ? paper.source : null,
		sources: [paper.source],
		categories: [...paper.categories],
		journal: paper.journal ?? null,
		landingUrl: paper.landingUrl,
		pdfUrl: paper.pdfUrl ?? null,
		publishedAt: paper.publishedAt,
		sourceUpdatedAt: paper.updatedAt,
		citedByCount: paper.citedByCount ?? null,
		authorCount: paper.authors.length
	};
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
	const out = [...a];
	for (const x of b) if (!out.includes(x)) out.push(x);
	return out;
}

function pickAbstract(
	existing: PaperFacet,
	incoming: PaperFacet
): Pick<PaperFacet, 'abstract' | 'abstractLicenseOk' | 'abstractSource'> {
	const keep = {
		abstract: existing.abstract,
		abstractLicenseOk: existing.abstractLicenseOk,
		abstractSource: existing.abstractSource
	};
	const take = {
		abstract: incoming.abstract,
		abstractLicenseOk: incoming.abstractLicenseOk,
		abstractSource: incoming.abstractSource
	};
	if (incoming.abstract === null) return keep;
	if (existing.abstract === null) return take;
	if (incoming.abstractLicenseOk && !existing.abstractLicenseOk) return take;
	if (!incoming.abstractLicenseOk && existing.abstractLicenseOk) return keep;
	// Gleiche Lizenzlage: nur dieselbe Quelle darf ihren Abstract aktualisieren.
	return incoming.abstractSource === existing.abstractSource ? take : keep;
}

export function mergeFacets(existing: PaperFacet, incoming: PaperFacet): MergeResult {
	const incomingWins =
		SOURCE_PRIORITY[incoming.metadataSource] >= SOURCE_PRIORITY[existing.metadataSource];
	const metadata = incomingWins ? incoming : existing;
	const takeIncomingAuthors =
		incoming.authorCount > 0 && (incomingWins || existing.authorCount === 0);

	return {
		takeIncomingAuthors,
		facet: {
			metadataSource: metadata.metadataSource,
			title: metadata.title,
			landingUrl: metadata.landingUrl,
			...pickAbstract(existing, incoming),
			sources: union(existing.sources, incoming.sources),
			categories: union(existing.categories, incoming.categories),
			journal: incomingWins
				? (incoming.journal ?? existing.journal)
				: (existing.journal ?? incoming.journal),
			pdfUrl: existing.pdfUrl ?? incoming.pdfUrl,
			publishedAt:
				incoming.publishedAt < existing.publishedAt ? incoming.publishedAt : existing.publishedAt,
			sourceUpdatedAt:
				incoming.sourceUpdatedAt > existing.sourceUpdatedAt
					? incoming.sourceUpdatedAt
					: existing.sourceUpdatedAt,
			citedByCount: incoming.citedByCount ?? existing.citedByCount,
			authorCount: takeIncomingAuthors ? incoming.authorCount : existing.authorCount
		}
	};
}

// ---------------------------------------------------------------------------
// IDs und Namen
// ---------------------------------------------------------------------------

const ID_FIELDS: Array<[keyof PaperIds, IdType]> = [
	['doi', 'doi'],
	['arxivId', 'arxiv'],
	['pmid', 'pmid'],
	['pmcid', 'pmcid'],
	['openalexId', 'openalex'],
	['europepmcId', 'europepmc']
];

export interface IdEntry {
	type: IdType;
	value: string;
}

/** Alle IDs eines Papers als (Typ, Wert)-Paare, deterministisch sortiert. */
export function idEntries(ids: PaperIds): IdEntry[] {
	const out: IdEntry[] = [];
	for (const [field, type] of ID_FIELDS) {
		const value = ids[field];
		if (value) out.push({ type, value });
	}
	return out.sort((a, b) => `${a.type}:${a.value}`.localeCompare(`${b.type}:${b.value}`));
}

/** Kleinschreibung, ohne Diakritika und Satzzeichen – für Autoren-Dedup und Namenssuche. */
export function normalizeAuthorName(name: string): string {
	return name
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.replace(/ß/g, 'ss')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}
