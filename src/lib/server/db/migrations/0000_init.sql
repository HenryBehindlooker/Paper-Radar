CREATE TYPE "public"."backfill_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."fetch_status" AS ENUM('ok', 'error', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."paper_id_type" AS ENUM('doi', 'arxiv', 'pmid', 'pmcid', 'openalex', 'europepmc');--> statement-breakpoint
CREATE TYPE "public"."source_name" AS ENUM('arxiv', 'europepmc', 'crossref', 'openalex');--> statement-breakpoint
CREATE TYPE "public"."subscription_type" AS ENUM('keyword', 'category', 'author');--> statement-breakpoint
CREATE TABLE "authors" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"orcid" text,
	"openalex_id" text
);
--> statement-breakpoint
CREATE TABLE "fetch_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" "source_name" NOT NULL,
	"kind" text NOT NULL,
	"source_query_id" bigint,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" "fetch_status" NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"new_paper_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"user_id" text NOT NULL,
	"paper_id" bigint NOT NULL,
	"score" real NOT NULL,
	"subscription_ids" bigint[] DEFAULT '{}' NOT NULL,
	"seen" boolean DEFAULT false NOT NULL,
	"saved" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_user_id_paper_id_pk" PRIMARY KEY("user_id","paper_id")
);
--> statement-breakpoint
CREATE TABLE "paper_authors" (
	"paper_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"author_id" bigint NOT NULL,
	CONSTRAINT "paper_authors_paper_id_position_pk" PRIMARY KEY("paper_id","position")
);
--> statement-breakpoint
CREATE TABLE "paper_ids" (
	"type" "paper_id_type" NOT NULL,
	"value" text NOT NULL,
	"paper_id" bigint NOT NULL,
	CONSTRAINT "paper_ids_type_value_pk" PRIMARY KEY("type","value")
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"abstract" text,
	"abstract_license_ok" boolean DEFAULT false NOT NULL,
	"abstract_source" "source_name",
	"metadata_source" "source_name" NOT NULL,
	"sources" "source_name"[] DEFAULT '{}' NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"journal" text,
	"landing_url" text NOT NULL,
	"pdf_url" text,
	"published_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cited_by_count" integer,
	"cited_by_updated_at" timestamp with time zone,
	"crossref_checked_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') || setweight(to_tsvector('english'::regconfig, coalesce(abstract, '')), 'B')) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_queries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" "subscription_type" NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"backfill_status" "backfill_status" DEFAULT 'pending' NOT NULL,
	"backfill_requested_at" timestamp with time zone,
	"backfill_finished_at" timestamp with time zone,
	"backfill_error" text
);
--> statement-breakpoint
CREATE TABLE "source_query_status" (
	"source_query_id" bigint NOT NULL,
	"source" "source_name" NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"covered_until" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "source_query_status_source_query_id_source_pk" PRIMARY KEY("source_query_id","source")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "subscription_type" NOT NULL,
	"query" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"source_query_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "fetch_log" ADD CONSTRAINT "fetch_log_source_query_id_source_queries_id_fk" FOREIGN KEY ("source_query_id") REFERENCES "public"."source_queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_authors" ADD CONSTRAINT "paper_authors_author_id_authors_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."authors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_ids" ADD CONSTRAINT "paper_ids_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_query_status" ADD CONSTRAINT "source_query_status_source_query_id_source_queries_id_fk" FOREIGN KEY ("source_query_id") REFERENCES "public"."source_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_source_query_id_source_queries_id_fk" FOREIGN KEY ("source_query_id") REFERENCES "public"."source_queries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "authors_orcid_key" ON "authors" USING btree ("orcid");--> statement-breakpoint
CREATE UNIQUE INDEX "authors_openalex_key" ON "authors" USING btree ("openalex_id");--> statement-breakpoint
CREATE UNIQUE INDEX "authors_name_no_orcid_key" ON "authors" USING btree ("name_normalized") WHERE orcid IS NULL;--> statement-breakpoint
CREATE INDEX "authors_name_idx" ON "authors" USING btree ("name_normalized");--> statement-breakpoint
CREATE INDEX "fetch_log_source_started_idx" ON "fetch_log" USING btree ("source","started_at");--> statement-breakpoint
CREATE INDEX "matches_user_score_idx" ON "matches" USING btree ("user_id","score");--> statement-breakpoint
CREATE INDEX "matches_paper_idx" ON "matches" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "paper_authors_author_idx" ON "paper_authors" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "paper_ids_paper_idx" ON "paper_ids" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "papers_search_idx" ON "papers" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "papers_published_at_idx" ON "papers" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "papers_first_seen_at_idx" ON "papers" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "papers_categories_idx" ON "papers" USING gin ("categories");--> statement-breakpoint
CREATE UNIQUE INDEX "source_queries_type_query_key" ON "source_queries" USING btree ("type","query");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_user_query_key" ON "subscriptions" USING btree ("user_id","source_query_id");--> statement-breakpoint
CREATE INDEX "subscriptions_source_query_idx" ON "subscriptions" USING btree ("source_query_id");