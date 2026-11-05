CREATE TYPE "public"."triage_job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "triage_jobs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "triage_jobs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"issue_id" bigint NOT NULL,
	"status" "triage_job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triage_jobs_attempts_non_negative" CHECK ("triage_jobs"."attempts" >= 0),
	CONSTRAINT "triage_jobs_running_has_lease" CHECK (("triage_jobs"."status" = 'running') = ("triage_jobs"."lease_token" is not null and "triage_jobs"."locked_until" is not null))
);
--> statement-breakpoint
ALTER TABLE "triage_jobs" ADD CONSTRAINT "triage_jobs_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "triage_jobs_one_pending_per_issue_key" ON "triage_jobs" USING btree ("issue_id") WHERE "triage_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "triage_jobs_pending_run_after_idx" ON "triage_jobs" USING btree ("run_after") WHERE "triage_jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "triage_jobs_running_locked_until_idx" ON "triage_jobs" USING btree ("locked_until") WHERE "triage_jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "triage_jobs_issue_id_idx" ON "triage_jobs" USING btree ("issue_id");