import { database } from './catalog';
import type { PcTask, TaskSummary } from '../domain/types';
import type { Draft } from '../agent/conversation-state';
import {
  sanitizeRecommendationResult,
  stripLegacyFps,
} from '../domain/sanitize';

type TaskRow = {
  id: string;
  name: string;
  draft: string;
  result: string | null;
  issues: string;
  version: number;
  updated_at: number;
};
function decode(row: TaskRow): PcTask {
  return {
    id: row.id,
    name: row.name,
    draft: stripLegacyFps(JSON.parse(row.draft)),
    result: row.result
      ? sanitizeRecommendationResult(JSON.parse(row.result))
      : null,
    issues: JSON.parse(row.issues),
    version: row.version,
    updatedAt: row.updated_at,
  };
}
export async function listTasks(sessionId: string): Promise<TaskSummary[]> {
  const rows = await database()
    .prepare(
      'SELECT id,name,draft,version,updated_at FROM tasks WHERE session_id=? ORDER BY updated_at DESC',
    )
    .bind(sessionId)
    .all<{
      id: string;
      name: string;
      draft: string;
      version: number;
      updated_at: number;
    }>();
  return rows.results.map((row) => {
    const draft = JSON.parse(row.draft) as Draft;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      updatedAt: row.updated_at,
      purpose: draft.purpose,
      budget: draft.budget,
    };
  });
}
export async function getTask(sessionId: string, taskId: string) {
  const row = await database()
    .prepare(
      'SELECT id,name,draft,result,issues,version,updated_at FROM tasks WHERE id=? AND session_id=?',
    )
    .bind(taskId, sessionId)
    .first<TaskRow>();
  if (!row) throw Error('任务不存在或不属于当前会话');
  return decode(row);
}
export async function ensureWorkspace(sessionId: string) {
  const db = database(),
    conversation = await db
      .prepare('SELECT messages,current_task_id FROM conversations WHERE id=?')
      .bind(sessionId)
      .first<{ messages: string; current_task_id: string | null }>();
  let currentTaskId = conversation?.current_task_id ?? null;
  if (!currentTaskId) {
    const existing = await db
      .prepare(
        'SELECT id FROM tasks WHERE session_id=? ORDER BY updated_at DESC LIMIT 1',
      )
      .bind(sessionId)
      .first<{ id: string }>();
    currentTaskId = existing?.id ?? crypto.randomUUID();
    const now = Date.now();
    await db.batch([
      db
        .prepare(
          'INSERT OR IGNORE INTO tasks(id,session_id,name,draft,result,issues,version,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(currentTaskId, sessionId, '我的主机', '{}', null, '[]', 1, now),
      db
        .prepare(
          'INSERT INTO conversations(id,draft,messages,current_task_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET current_task_id=excluded.current_task_id,updated_at=excluded.updated_at',
        )
        .bind(
          sessionId,
          '{}',
          conversation?.messages ?? '[]',
          currentTaskId,
          now,
        ),
    ]);
  }
  return {
    task: await getTask(sessionId, currentTaskId),
    messages: conversation ? JSON.parse(conversation.messages) : [],
    tasks: await listTasks(sessionId),
  };
}
export async function createTask(
  sessionId: string,
  name: string,
  draft: Draft = {},
) {
  const id = crypto.randomUUID(),
    now = Date.now(),
    db = database();
  await db.batch([
    db
      .prepare(
        'INSERT INTO tasks(id,session_id,name,draft,result,issues,version,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        sessionId,
        name.slice(0, 40) || '新主机',
        JSON.stringify(draft),
        null,
        '[]',
        1,
        now,
      ),
    db
      .prepare(
        'UPDATE conversations SET current_task_id=?,updated_at=? WHERE id=?',
      )
      .bind(id, now, sessionId),
  ]);
  return getTask(sessionId, id);
}
export async function switchTask(sessionId: string, taskId: string) {
  await getTask(sessionId, taskId);
  await database()
    .prepare(
      'UPDATE conversations SET current_task_id=?,updated_at=? WHERE id=?',
    )
    .bind(taskId, Date.now(), sessionId)
    .run();
  return getTask(sessionId, taskId);
}
export async function saveTask(
  sessionId: string,
  task: PcTask,
  expectedVersion: number,
) {
  // sessionId、task.id 与版本号共同限制更新范围，避免跨会话访问和旧异步请求覆盖新状态。
  const nextVersion = expectedVersion + 1,
    now = Date.now(),
    result = await database()
      .prepare(
        'UPDATE tasks SET name=?,draft=?,result=?,issues=?,version=?,updated_at=? WHERE id=? AND session_id=? AND version=?',
      )
      .bind(
        task.name,
        JSON.stringify(stripLegacyFps(task.draft)),
        task.result ? JSON.stringify(stripLegacyFps(task.result)) : null,
        JSON.stringify(task.issues),
        nextVersion,
        now,
        task.id,
        sessionId,
        expectedVersion,
      )
      .run();
  if (!result.meta.changes) throw Error('任务已被其他请求更新，请刷新后重试');
  return { ...task, version: nextVersion, updatedAt: now };
}

// 重置更换任务标识，旧请求持有的标识无法再更新任务；其他任务不受影响。
export async function resetTask(
  sessionId: string,
  task: PcTask,
  draft: Draft = {},
) {
  const db = database(),
    id = crypto.randomUUID(),
    now = Date.now();
  await db.batch([
    db
      .prepare(
        'INSERT INTO tasks(id,session_id,name,draft,result,issues,version,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        sessionId,
        '我的主机',
        JSON.stringify(draft),
        null,
        '[]',
        1,
        now,
      ),
    db
      .prepare('DELETE FROM tasks WHERE id=? AND session_id=?')
      .bind(task.id, sessionId),
    db
      .prepare(
        'UPDATE conversations SET current_task_id=?,draft=?,updated_at=? WHERE id=?',
      )
      .bind(id, '{}', now, sessionId),
    db.prepare('DELETE FROM sessions WHERE id=?').bind(sessionId),
  ]);
  return getTask(sessionId, id);
}
