CREATE TABLE `competitor_study_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`competitor_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`coverage` text,
	`pages_studied` integer,
	`error` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`competitor_id`) REFERENCES `competitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_study_runs_one_active_per_competitor_idx` ON `competitor_study_runs` (`competitor_id`) WHERE "competitor_study_runs"."status" IN ('pending', 'running');--> statement-breakpoint
ALTER TABLE `competitors` ADD `study_summary_json` text;