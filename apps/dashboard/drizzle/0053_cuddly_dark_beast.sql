CREATE TABLE `autopilot_state` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`consecutive_gate_failures` integer DEFAULT 0 NOT NULL,
	`paused_at` text,
	`paused_reason` text,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autopilot_state_project_id_unique` ON `autopilot_state` (`project_id`);--> statement-breakpoint
ALTER TABLE `writer_settings` ADD `digest_email` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `writer_settings` ADD `digest_webhook_url` text;