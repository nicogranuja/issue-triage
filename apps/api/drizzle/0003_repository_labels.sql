ALTER TABLE "repositories" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "labels_fetched_at" timestamp with time zone;