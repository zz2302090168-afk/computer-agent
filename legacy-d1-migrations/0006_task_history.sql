CREATE TABLE task_history (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  snapshot TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_task_history_operation ON task_history(task_id, operation_id);
CREATE INDEX idx_task_history_version ON task_history(task_id, source_version);
