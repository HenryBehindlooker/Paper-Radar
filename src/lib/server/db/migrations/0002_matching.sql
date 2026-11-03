CREATE TABLE "job_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "papers" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, left(coalesce(title, ''), 2000)), 'A') || setweight(to_tsvector('english'::regconfig, left(coalesce(abstract, ''), 50000)), 'B')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "relevance" real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "initial_matched_at" timestamp with time zone;--> statement-breakpoint
-- Der GIN-Index wird mit der Spalte gelöscht und muss neu angelegt werden.
CREATE INDEX IF NOT EXISTS "papers_search_idx" ON "papers" USING gin ("search_vector");
