ALTER TABLE "triage_suggestions" ADD COLUMN "labels_confidence" real NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "labels_rationale" text NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "priority_confidence" real NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "priority_rationale" text NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "duplicates_confidence" real NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "duplicates_rationale" text NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "input_tokens" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "output_tokens" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "cache_read_input_tokens" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "cache_creation_input_tokens" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "model_calls" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "latency_ms" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "triage_suggestions_one_pending_per_issue_key" ON "triage_suggestions" USING btree ("issue_id") WHERE "triage_suggestions"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD CONSTRAINT "triage_suggestions_labels_confidence_range" CHECK ("triage_suggestions"."labels_confidence" between 0 and 1);--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD CONSTRAINT "triage_suggestions_priority_confidence_range" CHECK ("triage_suggestions"."priority_confidence" between 0 and 1);--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD CONSTRAINT "triage_suggestions_duplicates_confidence_range" CHECK ("triage_suggestions"."duplicates_confidence" between 0 and 1);