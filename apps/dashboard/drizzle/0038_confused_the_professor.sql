CREATE TABLE `gsc_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`rows_written` integer,
	`error` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_sync_runs_one_active_per_project_idx` ON `gsc_sync_runs` (`project_id`) WHERE "gsc_sync_runs"."status" IN ('pending', 'running');