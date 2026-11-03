ALTER TABLE "matches" ADD COLUMN "saved_at" timestamp with time zone;--> statement-breakpoint
-- Bereits gemerkte Treffer erhalten ihren Anlagezeitpunkt.
UPDATE "matches" SET "saved_at" = "created_at" WHERE "saved" AND "saved_at" IS NULL;
