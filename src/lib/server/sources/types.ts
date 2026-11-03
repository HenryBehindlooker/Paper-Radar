/**
 * Gemeinsame Typen aller Datenquellen-Adapter.
 * Siehe docs/DATA_SOURCES.md für Endpunkte, Limits und Lizenzen.
 */

export type SourceName = 'arxiv' | 'europepmc' | 'crossref' | 'openalex';

export interface PaperIds {
	/** Kleingeschrieben, ohne `https://doi.org/`-Präfix. */
	doi?: string;
	/** Ohne Versionssuffix, z. B. `2103.00020` oder `hep-th/9711200`. */
	arxivId?: string;
	pmid?: string;
	/** Mit `PMC`-Präfix, z. B. `PMC13696524`. */
	pmcid?: string;
	/** Kurzform, z. B. `W2166248051`. */
	openalexId?: string;
	/** Europe-PMC-Quelle und -ID, z. B. `MED/42928415` oder `PPR/PPR1347660`. */
	europepmcId?: string;
}

export interface Author {
	name: string;
	/** ORCID ohne URL-Präfix, z. B. `0000-0002-1825-0097`. */
	orcid?: string;
	/** Kurzform, z. B. `A5018077134`. */
	openalexId?: string;
}

export interface NormalizedPaper {
	source: SourceName;
	ids: PaperIds;
	/** Titel ohne HTML-Markup; LaTeX (z. B. `$\mathbb P^3$`) bleibt unverändert erhalten. */
	title: string;
	/** Reiner Text ohne HTML/JATS-Markup. Nur gesetzt, wenn die Quelle einen liefert. */
	abstract?: string;
	/**
	 * `true` nur, wenn die Lizenzlage die Anzeige/Speicherung des Abstracts erlaubt
	 * (arXiv-Metadaten: CC0; sonst nur bei einer Creative-Commons- oder Public-Domain-Lizenz).
	 */
	abstractLicenseOk: boolean;
	authors: Author[];
	/** Fachkategorien der Quelle (arXiv: z. B. `cs.DL`). */
	categories: string[];
	publishedAt: Date;
	updatedAt: Date;
	landingUrl: string;
	/** Nur als Verweis – PDFs werden nie heruntergeladen oder gespiegelt. */
	pdfUrl?: string;
	/** Zeitschrift/Journal-Referenz, falls bekannt. */
	journal?: string;
	/** Zitationszahl (nur OpenAlex). */
	citedByCount?: number;
}

/** Abo-Typen, die eine Quelle durchsuchen kann. */
export type QueryKind = 'keyword' | 'category' | 'author';

export interface SourceQuery {
	kind: QueryKind;
	/**
	 * keyword: Postgres-`websearch_to_tsquery`-Syntax;
	 * category: arXiv-Kategorie (`cs.DL`);
	 * author: Name („Rui Yang“ / „Yang, Rui“) oder ORCID.
	 */
	value: string;
}

export interface SearchOptions {
	/** Obergrenze der zurückgegebenen Treffer (Schutz vor ausufernden Abfragen). */
	maxResults?: number;
	/** Ende des Zeitfensters (Standard: jetzt). */
	until?: Date;
}

export type IdType = 'doi' | 'arxiv' | 'pmid' | 'pmcid' | 'openalex' | 'europepmc';

export interface IdRef {
	type: IdType;
	value: string;
}

export interface PaperSource {
	readonly name: SourceName;
	/** Welche Abo-Typen `search` unterstützt; bei anderen liefert `search` `[]`. */
	readonly supportedQueryKinds: ReadonlySet<QueryKind>;
	/** Welche ID-Typen `getById` unterstützt; bei anderen liefert `getById` `[]`. */
	readonly supportedIdTypes: ReadonlySet<IdType>;
	search(query: SourceQuery, since: Date, options?: SearchOptions): Promise<NormalizedPaper[]>;
	/** Liefert `[]`, wenn die ID unbekannt ist. */
	getById(id: IdRef): Promise<NormalizedPaper[]>;
}
