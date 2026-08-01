CREATE TABLE "autopilot_state" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"consecutive_gate_failures" integer DEFAULT 0 NOT NULL,
	"paused_at" text,
	"paused_reason" text,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	CONSTRAINT "autopilot_state_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "writer_settings" ADD COLUMN "digest_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "writer_settings" ADD COLUMN "digest_webhook_url" text;--> statement-breakpoint
ALTER TABLE "autopilot_state" ADD CONSTRAINT "autopilot_state_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;