CREATE TYPE "public"."triage_effort" AS ENUM('low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
ALTER TABLE "triage_suggestions" ADD COLUMN "effort" "triage_effort";