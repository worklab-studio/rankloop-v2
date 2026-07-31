CREATE TABLE `site_study_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`audit_run_id` text,
	`pages_derived` integer,
	`error` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_study_runs_one_active_per_project_idx` ON `site_study_runs` (`project_id`) WHERE "site_study_runs"."status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `modified_at` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `outlink_paths_json` text;