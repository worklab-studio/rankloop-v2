CREATE TABLE `competitor_link_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`competitor_id` text NOT NULL,
	`domain` text NOT NULL,
	`domain_rank` integer,
	`backlinks` integer,
	`first_seen_at` text DEFAULT (current_timestamp) NOT NULL,
	`last_seen_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`competitor_id`) REFERENCES `competitors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competitor_link_domains_competitor_domain_idx` ON `competitor_link_domains` (`competitor_id`,`domain`);--> statement-breakpoint
CREATE TABLE `outreach_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`domain` text NOT NULL,
	`domain_rank` integer,
	`competitor_count` integer NOT NULL,
	`evidence_json` text NOT NULL,
	`matched_asset_page_id` text,
	`match_type_json` text,
	`template_kind` text,
	`draft_message` text,
	`status` text DEFAULT 'to_contact' NOT NULL,
	`contact_url` text,
	`notes` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`matched_asset_page_id`) REFERENCES `content_pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_targets_project_domain_idx` ON `outreach_targets` (`project_id`,`domain`);