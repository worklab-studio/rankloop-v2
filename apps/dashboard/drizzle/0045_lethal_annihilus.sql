CREATE TABLE `page_plan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`types_proposed` integer,
	`serp_sampled` integer,
	`cost_usd` real,
	`error` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_plan_runs_one_active_per_project_idx` ON `page_plan_runs` (`project_id`) WHERE "page_plan_runs"."status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `stale_as_of` text;