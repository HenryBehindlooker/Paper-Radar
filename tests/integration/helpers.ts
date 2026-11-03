import { sql } from 'drizzle-orm';
import { createDatabase, runMigrations, type Database, type Db } from '$lib/server/db/index';
import { users } from '$lib/server/db/schema';
import type { JobContext, JobSources } from '$lib/server/jobs/context';
import { silentLogger } from '$lib/server/log';
import type { ArxivRssItem } from '$lib/server/sources/arxiv';
import type {
	IdRef,
	IdType,
	NormalizedPaper,
	PaperSource,
	QueryKind,
	SearchOptions,
	SourceName,
	SourceQuery
} from '$lib/server/sources/types';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

if (!hasTestDb) {
	console.warn('TEST_DATABASE_URL nicht gesetzt – Integrationstests werden übersprungen.');
}

let shared: Database | undefined;

/** Verbindet sich mit der Testdatenbank und wendet die Migrationen an. */
export async function testDatabase(): Promise<Database> {
	if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL fehlt');
	if (!shared) {
		shared = createDatabase(TEST_DATABASE_URL, 6);
		await runMigrations(shared.db);
	}
	return shared;
}

export async function closeTestDatabase(): Promise<void> {
	await shared?.close();
	shared = undefined;
}

export async function resetDatabase(db: Db): Promise<void> {
	await db.execute(sql`TRUNCATE papers, paper_ids, authors, paper_authors, users, subscriptions,
		source_queries, source_query_status, matches, fetch_log, job_state RESTART IDENTITY CASCADE`);
}

export async function createUser(db: Db, email: string): Promise<string> {
	const [row] = await db.insert(users).values({ email }).returning({ id: users.id });
	return (row as { id: string }).id;
}

let counter = 0;

/** Minimales gültiges Paper; Felder lassen sich überschreiben. */
export function makePaper(overrides: Partial<NormalizedPaper> = {}): NormalizedPaper {
	counter++;
	return {
		source: 'arxiv',
		ids: { arxivId: `2610.${String(10000 + counter)}` },
		title: `Test paper ${counter}`,
		abstract: `Abstract ${counter}`,
		abstractLicenseOk: true,
		authors: [{ name: 'Ada Lovelace' }],
		categories: ['cs.DL'],
		publishedAt: new Date('2026-10-20T00:00:00Z'),
		updatedAt: new Date('2026-10-20T00:00:00Z'),
		landingUrl: `https://arxiv.org/abs/2610.${String(10000 + counter)}`,
		...overrides
	};
}

export interface RecordedSearch {
	query: SourceQuery;
	since: Date;
	options?: SearchOptions;
}

/** Attrappe einer Quelle mit aufgezeichneten Aufrufen. */
export class FakeSource implements PaperSource {
	readonly supportedIdTypes: ReadonlySet<IdType> = new Set();
	readonly searches: RecordedSearch[] = [];
	result: NormalizedPaper[] | ((q: SourceQuery) => NormalizedPaper[]) = [];
	error: Error | undefined;

	constructor(
		readonly name: SourceName,
		readonly supportedQueryKinds: ReadonlySet<QueryKind>
	) {}

	async search(query: SourceQuery, since: Date, options?: SearchOptions) {
		this.searches.push({ query, since, ...(options ? { options } : {}) });
		if (this.error) throw this.error;
		return typeof this.result === 'function' ? this.result(query) : this.result;
	}

	async getById(_id: IdRef): Promise<NormalizedPaper[]> {
		return [];
	}
}

export class FakeArxiv extends FakeSource {
	rss: ArxivRssItem[] = [];
	rssCalls: string[][] = [];
	rssError: Error | undefined;

	constructor() {
		super('arxiv', new Set<QueryKind>(['keyword', 'category', 'author']));
	}

	async fetchDailyAnnouncements(categories: readonly string[]) {
		this.rssCalls.push([...categories]);
		if (this.rssError) throw this.rssError;
		return this.rss;
	}
}

export class FakeCrossref {
	calls: string[][] = [];
	result: NormalizedPaper[] = [];
	error: Error | undefined;

	async getByDois(dois: readonly string[]) {
		this.calls.push([...dois]);
		if (this.error) throw this.error;
		return this.result;
	}
}

export function fakeSources() {
	const arxiv = new FakeArxiv();
	const europepmc = new FakeSource('europepmc', new Set<QueryKind>(['keyword', 'author']));
	const crossref = new FakeCrossref();
	const sources: JobSources = { arxiv, europepmc, crossref };
	return { arxiv, europepmc, crossref, sources };
}

export function jobContext(
	db: Db,
	sources: JobSources,
	now: Date
): JobContext & { clock: { now: Date } } {
	const clock = { now };
	return { db, sources, logger: silentLogger, now: () => clock.now, clock };
}
