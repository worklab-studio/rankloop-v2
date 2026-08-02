CREATE TABLE `ai_access_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`canonical_origin` text NOT NULL,
	`redirected` integer NOT NULL,
	`reachable` integer NOT NULL,
	`robots_state` text NOT NULL,
	`robots_text` text,
	`blocked_agents` integer NOT NULL,
	`llms_txt_present` integer NOT NULL,
	`llms_full_present` integer NOT NULL,
	`edge_blocked` integer NOT NULL,
	`html_words` integer,
	`payload` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_access_snapshots_project_created_idx` ON `ai_access_snapshots` (`project_id`,`created_at`);