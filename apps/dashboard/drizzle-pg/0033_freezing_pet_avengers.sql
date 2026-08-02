CREATE TABLE "submission_kits" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"tagline" text DEFAULT '' NOT NULL,
	"short_description" text DEFAULT '' NOT NULL,
	"long_description" text DEFAULT '' NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"logo_url" text,
	"categories_json" text DEFAULT '[]' NOT NULL,
	"pricing" text,
	"founder" text,
	"launch_date" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "lane" text DEFAULT 'link_gap' NOT NULL;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "submission_url" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "score" real;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "link_live_at" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "last_checked_at" text;--> statement-breakpoint
ALTER TABLE "outreach_targets" ADD COLUMN "verified_url" text;--> statement-breakpoint
ALTER TABLE "submission_kits" ADD CONSTRAINT "submission_kits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submission_kits_project_idx" ON "submission_kits" USING btree ("project_id");