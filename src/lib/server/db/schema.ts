import { sql, type SQL } from 'drizzle-orm';
import {
	bigint,
	bigserial,
	boolean,
	customType,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	real,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';

/**
 * Datenbankschema (PostgreSQL 16). Migrationen erzeugt `npm run db:generate`
 * in `src/lib/server/db/migrations/`.
 */

const tsvector = customType<{ data: string }>({
	dataType: () => 'tsvector'
});

const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const sourceNameEnum = pgEnum('source_name', ['arxiv', 'europepmc', 'crossref', 'openalex']);

export const paperIdTypeEnum = pgEnum('paper_id_type', [
	'doi',
	'arxiv',
	'pmid',
	'pmcid',
	'openalex',
	'europepmc'
]);

export const subscriptionTypeEnum = pgEnum('subscription_type', ['keyword', 'category', 'author']);

export const fetchStatusEnum = pgEnum('fetch_status', ['ok', 'error', 'skipped']);

export const backfillStatusEnum = pgEnum('backfill_status', [
	'pending',
	'running',
	'done',
	'failed'
]);

// ---------------------------------------------------------------------------
// Paper
// ---------------------------------------------------------------------------

/**
 * Volltext: Titel stark (A), Abstract schwächer (B) gewichtet. Konfiguration `english`,
 * da die Metadaten der Quellen ganz überwiegend englisch sind. Der indexierte Text ist
 * begrenzt, weil ein tsvector höchstens 1 MB groß sein darf (der Abstract selbst wird
 * vollständig gespeichert).
 */
export const SEARCH_VECTOR_SQL: SQL = sql`setweight(to_tsvector('english'::regconfig, left(coalesce(title, ''), 2000)), 'A') || setweight(to_tsvector('english'::regconfig, left(coalesce(abstract, ''), 50000)), 'B')`;

export const papers = pgTable(
	'papers',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		title: text('title').notNull(),
		abstract: text('abstract'),
		/** Darf der Abstract angezeigt werden? Sonst nur intern fürs Matching genutzt. */
		abstractLicenseOk: boolean('abstract_license_ok').notNull().default(false),
		abstractSource: sourceNameEnum('abstract_source'),
		/** Quelle, aus der Titel/Autoren/Links stammen (höchste Priorität gewinnt). */
		metadataSource: sourceNameEnum('metadata_source').notNull(),
		sources: sourceNameEnum('sources')
			.array()
			.notNull()
			.default(sql`'{}'`),
		categories: text('categories')
			.array()
			.notNull()
			.default(sql`'{}'`),
		journal: text('journal'),
		landingUrl: text('landing_url').notNull(),
		/** Nur Verweis – PDFs werden nie gespeichert. */
		pdfUrl: text('pdf_url'),
		publishedAt: tstz('published_at').notNull(),
		/** Letzte Änderung laut Quelle. */
		sourceUpdatedAt: tstz('source_updated_at').notNull(),
		/** Zeitpunkt der ersten Aufnahme in Paper-Radar (Grundlage für „neu seit letztem Lauf“). */
		firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
		lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
		citedByCount: integer('cited_by_count'),
		citedByUpdatedAt: tstz('cited_by_updated_at'),
		crossrefCheckedAt: tstz('crossref_checked_at'),
		searchVector: tsvector('search_vector').notNull().generatedAlwaysAs(SEARCH_VECTOR_SQL)
	},
	(t) => [
		index('papers_search_idx').using('gin', t.searchVector),
		index('papers_published_at_idx').on(t.publishedAt),
		index('papers_first_seen_at_idx').on(t.firstSeenAt),
		index('papers_categories_idx').using('gin', t.categories)
	]
);

export const paperIds = pgTable(
	'paper_ids',
	{
		type: paperIdTypeEnum('type').notNull(),
		value: text('value').notNull(),
		paperId: bigint('paper_id', { mode: 'number' })
			.notNull()
			.references(() => papers.id, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.type, t.value] }), index('paper_ids_paper_idx').on(t.paperId)]
);

export const authors = pgTable(
	'authors',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		name: text('name').notNull(),
		/** Kleingeschrieben, ohne Diakritika – für Dedup und Namenssuche. */
		nameNormalized: text('name_normalized').notNull(),
		orcid: text('orcid'),
		openalexId: text('openalex_id')
	},
	(t) => [
		uniqueIndex('authors_orcid_key').on(t.orcid),
		uniqueIndex('authors_openalex_key').on(t.openalexId),
		// Autor:innen ohne ORCID werden über den normalisierten Namen zusammengeführt.
		uniqueIndex('authors_name_no_orcid_key')
			.on(t.nameNormalized)
			.where(sql`orcid IS NULL`),
		index('authors_name_idx').on(t.nameNormalized)
	]
);

export const paperAuthors = pgTable(
	'paper_authors',
	{
		paperId: bigint('paper_id', { mode: 'number' })
			.notNull()
			.references(() => papers.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		authorId: bigint('author_id', { mode: 'number' })
			.notNull()
			.references(() => authors.id, { onDelete: 'cascade' })
	},
	(t) => [
		primaryKey({ columns: [t.paperId, t.position] }),
		index('paper_authors_author_idx').on(t.authorId)
	]
);

// ---------------------------------------------------------------------------
// Nutzer:innen & Abos
// ---------------------------------------------------------------------------

/**
 * Es wird ausschließlich die E-Mail-Adresse gespeichert (Datenschutz).
 * `name` und `image` verlangt der Auth.js-Drizzle-Adapter; sie bleiben beim
 * E-Mail-Login immer leer.
 */
export const users = pgTable('users', {
	id: text('id')
		.primaryKey()
		.default(sql`gen_random_uuid()::text`),
	email: text('email').notNull().unique(),
	emailVerified: tstz('email_verified'),
	name: text('name'),
	image: text('image'),
	createdAt: tstz('created_at').notNull().defaultNow(),
	/**
	 * Öffentliche ID des persönlichen Feeds (null = deaktiviert). Die Feed-URL enthält
	 * zusätzlich eine HMAC-Signatur, die nicht gespeichert wird.
	 */
	feedId: text('feed_id').unique(),
	/** Wochen-Mail abonniert (Opt-in). */
	weeklyDigest: boolean('weekly_digest').notNull().default(false),
	lastDigestSentAt: tstz('last_digest_sent_at')
});

/** Von Auth.js verlangt (OAuth-Konten); beim reinen E-Mail-Login leer. */
export const accounts = pgTable(
	'accounts',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		type: text('type').notNull(),
		provider: text('provider').notNull(),
		providerAccountId: text('provider_account_id').notNull(),
		refresh_token: text('refresh_token'),
		access_token: text('access_token'),
		expires_at: integer('expires_at'),
		token_type: text('token_type'),
		scope: text('scope'),
		id_token: text('id_token'),
		session_state: text('session_state')
	},
	(t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })]
);

/** Datenbank-Sessions (Cookie enthält nur das zufällige Session-Token). */
export const sessions = pgTable(
	'sessions',
	{
		sessionToken: text('session_token').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		expires: tstz('expires').notNull()
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

/** Magic-Link-Tokens (Auth.js speichert nur einen Hash des Tokens). */
export const verificationTokens = pgTable(
	'verification_tokens',
	{
		identifier: text('identifier').notNull(),
		token: text('token').notNull(),
		expires: tstz('expires').notNull()
	},
	(t) => [primaryKey({ columns: [t.identifier, t.token] })]
);

/**
 * Dedupliziertes Abo-Query: gleiche Anfragen mehrerer Nutzer:innen werden
 * zusammengefasst und nur einmal bei den Quellen abgefragt.
 */
export const sourceQueries = pgTable(
	'source_queries',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		type: subscriptionTypeEnum('type').notNull(),
		/** Normalisierte Form (siehe `normalizeQuery`), Schlüssel der Deduplizierung. */
		query: text('query').notNull(),
		createdAt: tstz('created_at').notNull().defaultNow(),
		lastRunAt: tstz('last_run_at'),
		backfillStatus: backfillStatusEnum('backfill_status').notNull().default('pending'),
		backfillRequestedAt: tstz('backfill_requested_at'),
		backfillFinishedAt: tstz('backfill_finished_at'),
		backfillError: text('backfill_error')
	},
	(t) => [uniqueIndex('source_queries_type_query_key').on(t.type, t.query)]
);

/** Stand je Quelle und Query: wann zuletzt erfolgreich abgefragt? */
export const sourceQueryStatus = pgTable(
	'source_query_status',
	{
		sourceQueryId: bigint('source_query_id', { mode: 'number' })
			.notNull()
			.references(() => sourceQueries.id, { onDelete: 'cascade' }),
		source: sourceNameEnum('source').notNull(),
		lastRunAt: tstz('last_run_at'),
		lastSuccessAt: tstz('last_success_at'),
		/** Ende des zuletzt erfolgreich abgefragten Zeitfensters. */
		coveredUntil: tstz('covered_until'),
		lastError: text('last_error')
	},
	(t) => [primaryKey({ columns: [t.sourceQueryId, t.source] })]
);

export const subscriptions = pgTable(
	'subscriptions',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		type: subscriptionTypeEnum('type').notNull(),
		/** Eingabe der Nutzerin/des Nutzers (Anzeige). */
		query: text('query').notNull(),
		weight: real('weight').notNull().default(1),
		sourceQueryId: bigint('source_query_id', { mode: 'number' })
			.notNull()
			.references(() => sourceQueries.id),
		createdAt: tstz('created_at').notNull().defaultNow(),
		/** Erstes Matching gegen bereits vorhandene Paper erledigt? (null = ausstehend) */
		initialMatchedAt: tstz('initial_matched_at')
	},
	(t) => [
		uniqueIndex('subscriptions_user_query_key').on(t.userId, t.sourceQueryId),
		index('subscriptions_source_query_idx').on(t.sourceQueryId)
	]
);

export const matches = pgTable(
	'matches',
	{
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		paperId: bigint('paper_id', { mode: 'number' })
			.notNull()
			.references(() => papers.id, { onDelete: 'cascade' }),
		/** Score inkl. Aktualitäts-Abfall zum Zeitpunkt des Matchings. */
		score: real('score').notNull(),
		/** Score ohne Aktualitäts-Abfall; der Feed rechnet den Abfall beim Lesen live. */
		relevance: real('relevance').notNull().default(0),
		/** Begründung je getroffenem Abo („Warum sehe ich das?“), siehe `MatchReason`. */
		reasons: jsonb('reasons')
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** IDs der getroffenen Abos. */
		subscriptionIds: bigint('subscription_ids', { mode: 'number' })
			.array()
			.notNull()
			.default(sql`'{}'`),
		seen: boolean('seen').notNull().default(false),
		saved: boolean('saved').notNull().default(false),
		/** Zeitpunkt des Merkens (Sortierung der Merkliste). */
		savedAt: tstz('saved_at'),
		hidden: boolean('hidden').notNull().default(false),
		createdAt: tstz('created_at').notNull().defaultNow()
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.paperId] }),
		index('matches_user_score_idx').on(t.userId, t.score),
		index('matches_paper_idx').on(t.paperId)
	]
);

/** Kleiner Schlüssel-Wert-Speicher für Job-Zustände (z. B. Matching-Wasserstand). */
export const jobState = pgTable('job_state', {
	key: text('key').primaryKey(),
	value: jsonb('value').notNull(),
	updatedAt: tstz('updated_at').notNull().defaultNow()
});

// ---------------------------------------------------------------------------
// Protokoll
// ---------------------------------------------------------------------------

export const fetchLog = pgTable(
	'fetch_log',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		source: sourceNameEnum('source').notNull(),
		/** z. B. `rss`, `search`, `backfill`, `lookup`. */
		kind: text('kind').notNull(),
		sourceQueryId: bigint('source_query_id', { mode: 'number' }).references(
			() => sourceQueries.id,
			{ onDelete: 'set null' }
		),
		startedAt: tstz('started_at').notNull(),
		finishedAt: tstz('finished_at').notNull(),
		status: fetchStatusEnum('status').notNull(),
		itemCount: integer('item_count').notNull().default(0),
		newPaperCount: integer('new_paper_count').notNull().default(0),
		error: text('error'),
		detail: jsonb('detail')
	},
	(t) => [index('fetch_log_source_started_idx').on(t.source, t.startedAt)]
);

export type Paper = typeof papers.$inferSelect;
export type SourceQuery = typeof sourceQueries.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
