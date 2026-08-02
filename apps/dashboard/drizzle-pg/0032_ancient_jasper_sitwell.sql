CREATE TABLE "ai_access_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"canonical_origin" text NOT NULL,
	"redirected" boolean NOT NULL,
	"reachable" boolean NOT NULL,
	"robots_state" text NOT NULL,
	"robots_text" text,
	"blocked_agents" integer NOT NULL,
	"llms_txt_present" boolean NOT NULL,
	"llms_full_present" boolean NOT NULL,
	"edge_blocked" boolean NOT NULL,
	"html_words" integer,
	"payload" jsonb NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_access_snapshots" ADD CONSTRAINT "ai_access_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_access_snapshots_project_created_idx" ON "ai_access_snapshots" USING btree ("project_id","created_at");