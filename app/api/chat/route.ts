import { env } from 'cloudflare:workers';
import { database, loadCatalog } from '@/backend/db/catalog';
import {
  ensureWorkspace,
  getTask,
  listTasks,
  saveTask,
  switchTask,
} from '@/backend/db/tasks';
import {
  readJson,
  sessionId,
  json,
  assertSameOrigin,
} from '@/backend/api/http';
import {
  runConversation,
  type ChatMessage,
  type ChatState,
  type StateEvent,
} from '@/backend/agent/conversation';
import type { PcTask } from '@/backend/domain/types';
import { executeTaskCommand } from '@/backend/tools/tasks';

function responseState(
  task: PcTask,
  messages: ChatMessage[],
  tasks: Awaited<ReturnType<typeof listTasks>>,
  events: StateEvent[] = [],
): ChatState {
  return {
    draft: task.draft,
    result: task.result,
    task,
    tasks,
    currentTaskId: task.id,
    messages,
    events,
    modelConfigured:
      !!env.MODEL_API_KEY && !!env.MODEL_NAME && !!env.MODEL_BASE_URL,
  };
}
export async function GET(request: Request) {
  try {
    const id = sessionId(request),
      workspace = await ensureWorkspace(id);
    return json(
      responseState(workspace.task, workspace.messages, workspace.tasks),
      200,
      id,
      new URL(request.url).protocol === 'https:',
    );
  } catch {
    return json({ error: '任务数据库尚未就绪' }, 503);
  }
}
export async function PATCH(request: Request) {
  try {
    const input = await readJson(request),
      id = sessionId(request);
    if (typeof input.taskId !== 'string') throw Error('任务 ID 无效');
    const task = await switchTask(id, input.taskId),
      workspace = await ensureWorkspace(id);
    return json(responseState(task, workspace.messages, workspace.tasks));
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : '无法切换任务' },
      400,
    );
  }
}
export async function POST(request: Request) {
  try {
    const input = await readJson(request);
    if (
      typeof input.message !== 'string' ||
      !input.message.trim() ||
      input.message.length > 2000
    )
      throw Error('请输入不超过 2000 字的消息');
    const message = input.message.trim(),
      id = sessionId(request);
    let workspace = await ensureWorkspace(id),
      task =
        typeof input.taskId === 'string'
          ? await getTask(id, input.taskId)
          : workspace.task;
    const taskAction = await executeTaskCommand(
      id,
      task,
      message,
      await listTasks(id),
    );
    task = taskAction.task;
    if (taskAction.reset) {
      const messages = [
        ...workspace.messages,
        {
          role: 'assistant' as const,
          content: '已清空这台主机的旧需求和配置。请告诉我新的预算和用途。',
          taskId: task.id,
        },
      ];
      await database()
        .prepare('UPDATE conversations SET messages=? WHERE id=?')
        .bind(JSON.stringify(messages), id)
        .run();
      return json(responseState(task, messages, await listTasks(id)));
    }
    if (taskAction.changed) {
      workspace = await ensureWorkspace(id);
    } else if (taskAction.reply) {
      const messages = [
        ...workspace.messages,
        { role: 'user' as const, content: message, taskId: task.id },
        {
          role: 'assistant' as const,
          content: taskAction.reply,
          taskId: task.id,
        },
      ].slice(-60);
      await database()
        .prepare('UPDATE conversations SET messages=?,updated_at=? WHERE id=?')
        .bind(JSON.stringify(messages), Date.now(), id)
        .run();
      return json(responseState(task, messages, await listTasks(id)));
    }
    const catalog = await loadCatalog(),
      events: StateEvent[] = [];
    let current = task;
    // 每次成功更新立即落库并递增版本；乐观锁会拒绝过期请求覆盖同一任务的新状态。
    const onUpdate = async (
      type: StateEvent['type'],
      draft: ChatState['draft'],
      result: ChatState['result'],
    ) => {
      const name =
        current.name === '我的主机' && draft.purpose
          ? `${draft.purpose}主机`
          : current.name;
      current = await saveTask(
        id,
        {
          ...current,
          name,
          draft,
          result,
          issues: result && !result.plans.length ? [result.summary] : [],
        },
        current.version,
      );
      events.push({ type, taskId: current.id, version: current.version });
      return current.version;
    };
    const currentMessages = workspace.messages.filter(
      (m: ChatMessage) => !m.taskId || m.taskId === task.id,
    );
    const next = await runConversation(
      {
        key: env.MODEL_API_KEY,
        base: env.MODEL_BASE_URL,
        model: env.MODEL_NAME,
      },
      {
        draft: task.draft,
        result: task.result,
        messages: currentMessages,
        currentTaskId: task.id,
      },
      message,
      catalog,
      loadCatalog,
      onUpdate,
      id,
    );
    const added = next.messages
        .slice(-2)
        .map((m) => ({ ...m, taskId: task.id })),
      messages = [...workspace.messages, ...added].slice(-60);
    // 旧请求不能在重置后写回包含旧需求的聊天上下文。
    const saved = await database()
      .prepare(
        'UPDATE conversations SET draft=?,messages=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND session_id=? AND version=?)',
      )
      .bind(
        '{}',
        JSON.stringify(messages),
        Date.now(),
        id,
        current.id,
        id,
        current.version,
      )
      .run();
    if (!saved.meta.changes) throw Error('任务已重置或更新，本次旧结果已丢弃');
    current = await getTask(id, task.id);
    return json({
      ...responseState(current, messages, await listTasks(id), events),
      modelConfigured: true,
    });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : '对话暂时失败' },
      400,
    );
  }
}
export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const id = sessionId(request),
      db = database();
    await db.batch([
      db.prepare('DELETE FROM tasks WHERE session_id=?').bind(id),
      db.prepare('DELETE FROM conversations WHERE id=?').bind(id),
      db.prepare('DELETE FROM sessions WHERE id=?').bind(id),
    ]);
    return json({ ok: true });
  } catch {
    return json({ error: '无法清除任务' }, 400);
  }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const id = crypto.randomUUID(),
      workspace = await ensureWorkspace(id);
    return json(
      responseState(workspace.task, workspace.messages, workspace.tasks),
      200,
      id,
      new URL(request.url).protocol === 'https:',
    );
  } catch {
    return json({ error: '无法开始新会话' }, 503);
  }
}
