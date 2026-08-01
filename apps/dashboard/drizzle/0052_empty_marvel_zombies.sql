CREATE TABLE `digests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`for_date` text NOT NULL,
	`payload_json` text NOT NULL,
	`delivered_json` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digests_project_for_date_idx` ON `digests` (`project_id`,`for_date`);--> statement-breakpoint
ALTER TABLE `proposals` ADD `decided_by` text;