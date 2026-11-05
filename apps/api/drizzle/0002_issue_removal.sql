CREATE TYPE "public"."issue_removal_reason" AS ENUM('deleted', 'transferred');--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "removal_reason" "issue_removal_reason";--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_removal_complete" CHECK (("issues"."removed_at" is null) = ("issues"."removal_reason" is null));