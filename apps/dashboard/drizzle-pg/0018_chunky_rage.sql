CREATE TABLE "competitor_study_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"competitor_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"coverage" text,
	"pages_studied" integer,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN "study_summary_json" text;--> statement-breakpoint
ALTER TABLE "competitor_study_runs" ADD CONSTRAINT "competitor_study_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_study_runs" ADD CONSTRAINT "competitor_study_runs_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_study_runs_one_active_per_competitor_idx" ON "competitor_study_runs" USING btree ("competitor_id") WHERE "competitor_study_runs"."status" IN ('pending', 'running');