CREATE TABLE "content_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"description" text,
	"published_at" text,
	"modified_at" text,
	"word_count" integer,
	"category" text,
	"keyword" text,
	"page_type_id" text,
	"inlink_count" integer,
	"outlink_paths_json" text,
	"content_hash" text,
	"source" text NOT NULL,
	"last_crawled_at" text
);
--> statement-breakpoint
CREATE TABLE "gsc_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"page_id" text NOT NULL,
	"query_id" text NOT NULL,
	"date" text NOT NULL,
	"grain" text DEFAULT 'day' NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"query" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexation_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"verdict" text NOT NULL,
	"coverage_state" text,
	"checked_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "serp_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"purpose" text NOT NULL,
	"organic_json" text NOT NULL,
	"paa_json" text,
	"features_json" text,
	"fetched_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"proposal_id" text NOT NULL,
	"page_type_id" text,
	"keyword" text NOT NULL,
	"slug" text,
	"title" text,
	"description" text,
	"status" text DEFAULT 'briefing' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"writer_mode" text NOT NULL,
	"model" text,
	"brief_md" text,
	"content" text,
	"law_report_json" text,
	"adapter" text,
	"adapter_ref" text,
	"published_url" text,
	"published_at" text,
	"cost_usd" real,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"competitor_id" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"page_type" text,
	"etv" real,
	"keyword_count" integer,
	"word_count" integer,
	"structural_features_json" text,
	"status" text DEFAULT 'active' NOT NULL,
	"first_seen_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"last_seen_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"discovered_via" text,
	"domain_rank" integer,
	"organic_keywords" integer,
	"est_traffic" real,
	"backlinks" integer,
	"referring_domains" integer,
	"coverage" text,
	"last_studied_at" text
);
--> statement-breakpoint
CREATE TABLE "keyword_backlog" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"keyword" text NOT NULL,
	"source" text NOT NULL,
	"seed" text,
	"category" text,
	"format" text,
	"page_type_id" text,
	"search_volume" integer,
	"keyword_difficulty" integer,
	"intent" text,
	"score" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"cluster_key" text,
	"notes_json" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_spend" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" real NOT NULL,
	"article_id" text,
	"occurred_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_type_data" (
	"id" text PRIMARY KEY NOT NULL,
	"page_type_id" text NOT NULL,
	"entity" text NOT NULL,
	"row_json" text NOT NULL,
	"provenance_json" text NOT NULL,
	"confidence" real,
	"needs_review" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_types" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"url_pattern" text,
	"keyword_pattern" text,
	"template_contract_json" text,
	"data_source_json" text,
	"hub_content_page_id" text,
	"evidence_json" text,
	"serp_check_json" text,
	"demand" integer,
	"instance_count" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"decided_at" text
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"track" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"target" text NOT NULL,
	"title" text,
	"page_type_id" text,
	"keyword_backlog_id" text,
	"content_page_id" text,
	"score" real NOT NULL,
	"factors_json" text,
	"evidence_json" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"expires_at" text,
	"decided_at" text,
	"executed_at" text
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"action_type" text NOT NULL,
	"article_id" text,
	"content_page_id" text,
	"target_query" text,
	"status" text DEFAULT 'baseline' NOT NULL,
	"baseline_json" text,
	"result_json" text,
	"window_start" text,
	"window_end" text,
	"measured_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_page_type_id_page_types_id_fk" FOREIGN KEY ("page_type_id") REFERENCES "public"."page_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_pages" ADD CONSTRAINT "gsc_pages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_performance" ADD CONSTRAINT "gsc_performance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_performance" ADD CONSTRAINT "gsc_performance_page_id_gsc_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."gsc_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_performance" ADD CONSTRAINT "gsc_performance_query_id_gsc_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."gsc_queries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_queries" ADD CONSTRAINT "gsc_queries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indexation_checks" ADD CONSTRAINT "indexation_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_snapshots" ADD CONSTRAINT "serp_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_pages" ADD CONSTRAINT "competitor_pages_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_backlog" ADD CONSTRAINT "keyword_backlog_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_backlog" ADD CONSTRAINT "keyword_backlog_page_type_id_page_types_id_fk" FOREIGN KEY ("page_type_id") REFERENCES "public"."page_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_spend" ADD CONSTRAINT "llm_spend_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_type_data" ADD CONSTRAINT "page_type_data_page_type_id_page_types_id_fk" FOREIGN KEY ("page_type_id") REFERENCES "public"."page_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_types" ADD CONSTRAINT "page_types_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_pages_project_url_idx" ON "content_pages" USING btree ("project_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_pages_project_url_idx" ON "gsc_pages" USING btree ("project_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_performance_project_page_query_date_grain_idx" ON "gsc_performance" USING btree ("project_id","page_id","query_id","date","grain");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_queries_project_query_idx" ON "gsc_queries" USING btree ("project_id","query");--> statement-breakpoint
CREATE INDEX "indexation_checks_project_url_checked_idx" ON "indexation_checks" USING btree ("project_id","url","checked_at");--> statement-breakpoint
CREATE INDEX "serp_snapshots_project_keyword_fetched_idx" ON "serp_snapshots" USING btree ("project_id","keyword","fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "articles_one_in_flight_per_proposal_idx" ON "articles" USING btree ("proposal_id") WHERE "articles"."status" NOT IN ('published', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_pages_competitor_url_idx" ON "competitor_pages" USING btree ("competitor_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_project_domain_idx" ON "competitors" USING btree ("project_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "keyword_backlog_project_keyword_idx" ON "keyword_backlog" USING btree ("project_id","keyword");--> statement-breakpoint
CREATE INDEX "llm_spend_project_occurred_idx" ON "llm_spend" USING btree ("project_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "page_type_data_page_type_entity_idx" ON "page_type_data" USING btree ("page_type_id","entity");--> statement-breakpoint
CREATE UNIQUE INDEX "page_types_project_name_idx" ON "page_types" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_one_active_per_target_idx" ON "proposals" USING btree ("project_id","type","target") WHERE "proposals"."status" IN ('proposed', 'approved', 'executing');--> statement-breakpoint
CREATE INDEX "receipts_project_status_idx" ON "receipts" USING btree ("project_id","status");