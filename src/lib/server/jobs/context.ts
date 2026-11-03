import type { Db } from '../db/index';
import type { Logger } from '../log';
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
}

export const DAY_MS = 86_400_000;
