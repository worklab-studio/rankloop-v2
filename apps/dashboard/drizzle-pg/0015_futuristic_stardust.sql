CREATE TABLE "gsc_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"range_start" text NOT NULL,
	"range_end" text NOT NULL,
	"rows_written" integer,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "gsc_sync_runs" ADD CONSTRAINT "gsc_sync_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_sync_runs_one_active_per_project_idx" ON "gsc_sync_runs" USING btree ("project_id") WHERE "gsc_sync_runs"."status" IN ('pending', 'running');