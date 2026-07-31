CREATE TABLE `writer_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`posts_per_day` integer DEFAULT 2 NOT NULL,
	`catchup_cap` integer DEFAULT 6 NOT NULL,
	`quota_start_date` text,
	`voice_card_md` text,
	`trust_dial` text DEFAULT 'titles' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `writer_settings_project_id_unique` ON `writer_settings` (`project_id`);