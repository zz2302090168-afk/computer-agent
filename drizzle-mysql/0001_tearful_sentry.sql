CREATE TABLE `monitors` (
	`id` varchar(191) NOT NULL,
	`brand` varchar(191) NOT NULL,
	`name` varchar(255) NOT NULL,
	`price` int NOT NULL,
	`specs` text NOT NULL,
	`demo` int NOT NULL DEFAULT 1,
	CONSTRAINT `monitors_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_monitors_price` ON `monitors` (`price`);