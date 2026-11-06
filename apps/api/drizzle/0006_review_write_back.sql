CREATE TYPE "public"."job_kind" AS ENUM('triage', 'write_back');--> statement-breakpoint
DROP INDEX "triage_jobs_one_pending_per_issue_key";--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "labels_added" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "labels_removed" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD COLUMN "kind" "job_kind" DEFAULT 'triage' NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD COLUMN "review_id" bigint;--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD CONSTRAINT "triage_jobs_review_id_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "triage_jobs_review_id_key" ON "triage_jobs" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "triage_jobs_one_pending_per_issue_key" ON "triage_jobs" USING btree ("issue_id") WHERE "triage_jobs"."status" = 'pending' and "triage_jobs"."kind" = 'triage';--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD CONSTRAINT "triage_jobs_write_back_has_review" CHECK (("triage_jobs"."kind" = 'write_back') = ("triage_jobs"."review_id" is not null));