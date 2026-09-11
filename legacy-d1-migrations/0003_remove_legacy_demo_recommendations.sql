DELETE FROM `conversations`
WHERE `id` IN (
	SELECT `id` FROM `sessions`
	WHERE `plans` LIKE '%"demo":true%'
);
--> statement-breakpoint
DELETE FROM `sessions`
WHERE `plans` LIKE '%"demo":true%';
--> statement-breakpoint
DELETE FROM `prebuilts`
WHERE `demo` = 1 AND `brand` = '星构 DEMO';
--> statement-breakpoint
DELETE FROM `products`
WHERE `demo` = 1 AND `brand` = '星构 DEMO';
