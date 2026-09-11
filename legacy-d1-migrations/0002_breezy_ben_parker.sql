CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`draft` text NOT NULL,
	`messages` text NOT NULL,
	`updated_at` integer NOT NULL
);
