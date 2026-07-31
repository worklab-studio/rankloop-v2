CREATE TABLE "keyword_universe_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sources_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"seen_count" integer,
	"kept_count" integer,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "project_gate" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"positives_json" text NOT NULL,
	"negatives_json" text NOT NULL,
	"brand_tokens_json" text NOT NULL,
	"kd_ceiling" integer DEFAULT 20 NOT NULL,
	"kd_ceiling_updated_at" text,
	"user_edited" boolean DEFAULT false NOT NULL,
	"derived_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "keyword_universe_runs" ADD CONSTRAINT "keyword_universe_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_gate" ADD CONSTRAINT "project_gate_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_universe_runs_one_active_per_project_idx" ON "keyword_universe_runs" USING btree ("project_id") WHERE "keyword_universe_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "project_gate_project_idx" ON "project_gate" USING btree ("project_id");