ALTER TABLE `conversations` ADD `current_task_id` text;
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`name` text NOT NULL,
	`draft` text NOT NULL,
	`result` text,
	`issues` text NOT NULL,
	`version` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_session_updated` ON `tasks` (`session_id`,`updated_at`);
