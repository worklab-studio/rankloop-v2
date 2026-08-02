CREATE TABLE `submission_kits` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`short_description` text DEFAULT '' NOT NULL,
	`long_description` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	`logo_url` text,
	`categories_json` text DEFAULT '[]' NOT NULL,
	`pricing` text,
	`founder` text,
	`launch_date` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submission_kits_project_idx` ON `submission_kits` (`project_id`);--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `lane` text DEFAULT 'link_gap' NOT NULL;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `submission_url` text;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `score` real;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `link_live_at` text;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `last_checked_at` text;--> statement-breakpoint
ALTER TABLE `outreach_targets` ADD `verified_url` text;