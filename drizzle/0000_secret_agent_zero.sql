CREATE TABLE `prebuilts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`brand` text NOT NULL,
	`color` text NOT NULL,
	`price` integer NOT NULL,
	`part_ids` text NOT NULL,
	`demo` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`brand` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`price` integer NOT NULL,
	`specs` text NOT NULL,
	`demo` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_products_category_price` ON `products` (`category`,`price`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`requirements` text NOT NULL,
	`plans` text NOT NULL,
	`updated_at` integer NOT NULL
);
