import type { Db } from '../db/index';
import type { DigestContext } from '../digest';
import type { EnrichContext } from '../enrichment/openalex';
import type { Logger } from '../log';
import type { RankingConfig } from '../ranking/score';
import type { ArxivSource } from '../sources/arxiv';
import type { CrossrefSource } from '../sources/crossref';
import type { PaperSource } from '../sources/types';

/** Abhängigkeiten der Jobs – in Tests durch Attrappen ersetzbar. */
export interface JobSources {
	arxiv: PaperSource & Pick<ArxivSource, 'fetchDailyAnnouncements'>;
	europepmc: PaperSource;
	crossref: Pick<CrossrefSource, 'getByDois'>;
}

export interface JobContext {
	db: Db;
	sources: JobSources;
	logger: Logger;
	now: () => Date;
	ranking?: RankingConfig;
	/** Versand der Wochen-Mail; fehlt die Konfiguration (ORIGIN/AUTH_SECRET), wird übersprungen. */
	digest?: Pick<DigestContext, 'origin' | 'key' | 'send'>;
	/** OpenAlex-Anreicherung (Quelle, Verbrauchszähler, Budget). */
	enrichment?: Pick<EnrichContext, 'openalex' | 'tracker' | 'budget'>;
}

export const DAY_MS = 86_400_000;
