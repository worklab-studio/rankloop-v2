CREATE TABLE "page_plan_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"types_proposed" integer,
	"serp_sampled" integer,
	"cost_usd" real,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "stale_as_of" text;--> statement-breakpoint
ALTER TABLE "page_plan_runs" ADD CONSTRAINT "page_plan_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_plan_runs_one_active_per_project_idx" ON "page_plan_runs" USING btree ("project_id") WHERE "page_plan_runs"."status" IN ('pending', 'running');