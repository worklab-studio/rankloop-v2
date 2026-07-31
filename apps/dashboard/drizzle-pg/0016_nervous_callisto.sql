CREATE TABLE "site_study_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"audit_run_id" text,
	"pages_derived" integer,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "published_at" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "modified_at" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "outlink_paths_json" text;--> statement-breakpoint
ALTER TABLE "site_study_runs" ADD CONSTRAINT "site_study_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_study_runs_one_active_per_project_idx" ON "site_study_runs" USING btree ("project_id") WHERE "site_study_runs"."status" IN ('pending', 'running');