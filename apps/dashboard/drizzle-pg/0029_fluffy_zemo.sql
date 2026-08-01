CREATE TABLE "digests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"for_date" text NOT NULL,
	"payload_json" text NOT NULL,
	"delivered_json" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decided_by" text;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digests_project_for_date_idx" ON "digests" USING btree ("project_id","for_date");