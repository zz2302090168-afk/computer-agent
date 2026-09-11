import { database, loadCatalog } from './catalog';
import { auditDelivery } from '../services/delivery-audit';
import { completeRequirements } from '../agent/conversation-state';
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
  const task = decode(row);
  if (task.result?.plans.length) {
    try {
      task.result = {
        ...task.result,
        requirements: completeRequirements(task.draft),
        plans: auditDelivery(
          task.result.plans,
          completeRequirements(task.draft),
          await loadCatalog(),
        ),
      };
    } catch (cause) {
      // 恢复时不展示不合格旧配置，也不保留旧的确认状态。
      task.result = null;
      task.issues = [
        cause instanceof Error
          ? cause.message
          : '旧配置交付审核未通过，请重新生成',
      ];
      task.draft = {
        ...task.draft,
        partSelections: {},
        selectionSources: {},
        selectionConfirmationMessageIds: {},
      };
    }
  }
  return task;
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
          'INSERT IGNORE INTO tasks(id,session_id,name,draft,result,issues,version,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(currentTaskId, sessionId, '我的主机', '{}', null, '[]', 1, now),
      db
        .prepare(
          'INSERT INTO conversations(id,draft,messages,current_task_id,updated_at) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE current_task_id=VALUES(current_task_id),updated_at=VALUES(updated_at)',
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
  operationId = crypto.randomUUID(),
  recordHistory = true,
) {
  // sessionId、task.id 与版本号共同限制更新范围，避免跨会话访问和旧异步请求覆盖新状态。
  const nextVersion = expectedVersion + 1,
    now = Date.now(),
    db = database(),
    previous = await db
      .prepare(
        'SELECT id,name,draft,result,issues,version,updated_at FROM tasks WHERE id=? AND session_id=? AND version=?',
      )
      .bind(task.id, sessionId, expectedVersion)
      .first<TaskRow>();
  if (!previous) throw Error('任务已被其他请求更新，请刷新后重试');
  const results = await db.batch([
    ...(recordHistory
      ? [
          db
            .prepare(
              'INSERT IGNORE INTO task_history(id,task_id,operation_id,source_version,snapshot) SELECT ?,id,?,?,? FROM tasks WHERE id=? AND session_id=? AND version=?',
            )
            .bind(
              crypto.randomUUID(),
              operationId,
              expectedVersion,
              JSON.stringify(decode(previous)),
              task.id,
              sessionId,
              expectedVersion,
            ),
        ]
      : []),
    db
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
      ),
  ]);
  if (!results.at(-1)!.meta.changes)
    throw Error('任务已被其他请求更新，请刷新后重试');
  return { ...task, version: nextVersion, updatedAt: now };
}

export async function undoTask(
  sessionId: string,
  taskId: string,
  expectedVersion: number,
) {
  const db = database();
  return db.transaction(async (tx) => {
    const entry = await tx
      .prepare(
        'SELECT h.id,h.snapshot,t.draft AS current_draft FROM task_history h JOIN tasks t ON t.id=h.task_id WHERE t.id=? AND t.session_id=? AND t.version=? ORDER BY h.source_version DESC LIMIT 1 FOR UPDATE',
      )
      .bind(taskId, sessionId, expectedVersion)
      .first<{ id: string; snapshot: string; current_draft: string }>();
    if (!entry)
      throw Error(
        '当前任务没有可撤回的更改，或任务已更新；历史记录仅从启用撤回功能后开始保存',
      );
    const previous = JSON.parse(entry.snapshot) as PcTask;
    const draft = {
      ...stripLegacyFps(previous.draft),
      support: (JSON.parse(entry.current_draft) as Draft).support,
    };
    let result = previous.result
      ? sanitizeRecommendationResult(previous.result)
      : null;
    if (result?.plans.length) {
      const requirements = completeRequirements(draft);
      result = {
        ...result,
        requirements,
        plans: auditDelivery(result.plans, requirements, await loadCatalog()),
        evaluation: undefined,
        explanation: null,
        summary: '已撤回上一次更改，恢复的配置已按当前目录重新审核。',
      };
    }
    const now = Date.now();
    const saved = await tx
      .prepare(
        'UPDATE tasks SET name=?,draft=?,result=?,issues=?,version=version+1,updated_at=? WHERE id=? AND session_id=? AND version=?',
      )
      .bind(
        previous.name,
        JSON.stringify(draft),
        result ? JSON.stringify(result) : null,
        JSON.stringify(previous.issues),
        now,
        taskId,
        sessionId,
        expectedVersion,
      )
      .run();
    if (!saved.meta.changes) throw Error('任务已被其他请求更新，撤回未执行');
    await tx.prepare('DELETE FROM task_history WHERE id=?').bind(entry.id).run();
    return {
      ...previous,
      id: taskId,
      draft,
      result,
      version: expectedVersion + 1,
      updatedAt: now,
    };
  });
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
  // 三条语句都以旧任务版本为前提：并发请求若已更新旧任务，就不会生成孤立的新任务或切走当前任务。
  await db.batch([
    db
      .prepare(
        'INSERT INTO tasks(id,session_id,name,draft,result,issues,version,updated_at) SELECT ?,session_id,?,?,?,?,?,? FROM tasks WHERE id=? AND session_id=? AND version=? AND EXISTS(SELECT 1 FROM conversations WHERE id=? AND current_task_id=?)',
      )
      .bind(
        id,
        task.name,
        JSON.stringify(draft),
        null,
        '[]',
        1,
        now,
        task.id,
        sessionId,
        task.version,
        sessionId,
        task.id,
      ),
    db
      .prepare(
        'UPDATE conversations SET current_task_id=?,draft=?,updated_at=? WHERE id=? AND current_task_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND session_id=?)',
      )
      .bind(id, '{}', now, sessionId, task.id, id, sessionId),
    db
      .prepare(
        'DELETE FROM tasks WHERE id=? AND session_id=? AND version=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND session_id=?)',
      )
      .bind(task.id, sessionId, task.version, id, sessionId),
  ]);
  return getTask(sessionId, id);
}
