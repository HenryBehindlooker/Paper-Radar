ALTER TABLE "users" ADD COLUMN "feed_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weekly_digest" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_digest_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_feed_id_unique" UNIQUE("feed_id");