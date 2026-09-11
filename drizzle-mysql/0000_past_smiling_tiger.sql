CREATE TABLE `conversations` (
	`id` varchar(191) NOT NULL,
	`draft` longtext NOT NULL,
	`messages` longtext NOT NULL,
	`current_task_id` varchar(191),
	`updated_at` bigint NOT NULL,
	CONSTRAINT `conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` varchar(191) NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT `metadata_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `prebuilts` (
	`id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`brand` varchar(191) NOT NULL,
	`color` varchar(32) NOT NULL,
	`price` int NOT NULL,
	`part_ids` text NOT NULL,
	`demo` int NOT NULL DEFAULT 1,
	CONSTRAINT `prebuilts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(191) NOT NULL,
	`category` varchar(32) NOT NULL,
	`brand` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`color` varchar(32) NOT NULL,
	`price` int NOT NULL,
	`specs` text NOT NULL,
	`demo` int NOT NULL DEFAULT 1,
	CONSTRAINT `products_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `task_history` (
	`id` varchar(191) NOT NULL,
	`task_id` varchar(191) NOT NULL,
	`operation_id` varchar(191) NOT NULL,
	`source_version` int NOT NULL,
	`snapshot` longtext NOT NULL,
	CONSTRAINT `task_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `idx_task_history_operation` UNIQUE(`task_id`,`operation_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` varchar(191) NOT NULL,
	`session_id` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`draft` longtext NOT NULL,
	`result` longtext,
	`issues` longtext NOT NULL,
	`version` int NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `tasks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `task_history` ADD CONSTRAINT `task_history_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_products_category_price` ON `products` (`category`,`price`);--> statement-breakpoint
CREATE INDEX `idx_task_history_version` ON `task_history` (`task_id`,`source_version`);