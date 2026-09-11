INSERT INTO `tasks` (`id`,`session_id`,`name`,`draft`,`result`,`issues`,`version`,`updated_at`)
SELECT
  'legacy-session-' || `s`.`id`,
  `s`.`id`,
  '旧版配置迁移',
  `s`.`requirements`,
  '{"requirements":' || `s`.`requirements` || ',"plans":' || `s`.`plans` || ',"summary":"已从旧版工作台迁移到任务。"}',
  '[]',
  1,
  `s`.`updated_at`
FROM `sessions` AS `s`
WHERE NOT EXISTS (SELECT 1 FROM `tasks` AS `t` WHERE `t`.`session_id` = `s`.`id`);
--> statement-breakpoint
UPDATE `conversations`
SET `current_task_id` = 'legacy-session-' || `id`
WHERE (`current_task_id` IS NULL OR `current_task_id` = '')
  AND EXISTS (SELECT 1 FROM `tasks` AS `t` WHERE `t`.`id` = 'legacy-session-' || `conversations`.`id`);
--> statement-breakpoint
DROP TABLE `sessions`;
