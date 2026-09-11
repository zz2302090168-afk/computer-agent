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
import type { ChatStreamEvent } from '@/backend/agent/progress';

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
      !!process.env.MODEL_API_KEY &&
      !!process.env.MODEL_NAME &&
      !!process.env.MODEL_BASE_URL,
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
      id = sessionId(request),
      messageId = crypto.randomUUID();
    const cancellation = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      cancellation.signal,
      AbortSignal.timeout(300000),
    ]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: ChatStreamEvent) => {
          if (!cancellation.signal.aborted)
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        try {
          emit({
            type: 'progress',
            progress: {
              scope: 'main',
              label: '读取当前任务与商品目录',
              status: 'running',
            },
          });
          const workspace = await ensureWorkspace(id),
            task =
              typeof input.taskId === 'string'
                ? await getTask(id, input.taskId)
                : workspace.task;
          const catalog = await loadCatalog(),
            events: StateEvent[] = [];
          let current = task;
          // 每次成功更新立即落库并递增版本；乐观锁会拒绝过期请求覆盖同一任务的新状态。
          const onUpdate = async (
            type: StateEvent['type'],
            draft: ChatState['draft'],
            result: ChatState['result'],
          ) => {
            signal.throwIfAborted();
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
              messageId,
              type !== 'support',
            );
            events.push({ type, taskId: current.id, version: current.version });
            return current.version;
          };
          const currentMessages = workspace.messages.filter(
            (m: ChatMessage) => !m.taskId || m.taskId === task.id,
          );
          const next = await runConversation(
            {
              key: process.env.MODEL_API_KEY,
              base: process.env.MODEL_BASE_URL,
              model: process.env.MODEL_NAME,
            },
            {
              draft: task.draft,
              result: task.result,
              messages: currentMessages,
              task,
              tasks: workspace.tasks,
              currentTaskId: task.id,
            },
            message,
            messageId,
            catalog,
            loadCatalog,
            onUpdate,
            id,
            async (changedTask) => {
              current = changedTask;
              events.push({
                type: 'task',
                taskId: changedTask.id,
                version: changedTask.version,
              });
            },
            (progress) => emit({ type: 'progress', progress }),
            signal,
            {
              key: process.env.EMBEDDING_API_KEY,
              base: process.env.EMBEDDING_BASE_URL,
              model: process.env.EMBEDDING_MODEL,
            },
          );
          signal.throwIfAborted();
          const added = next.messages
              .slice(-2)
              .map((m) => ({ ...m, taskId: next.taskId })),
            messages = [...workspace.messages, ...added].slice(-60);
          // 旧请求不能在重置后写回包含旧需求的聊天上下文。
          const saved = await database()
            .prepare(
              'UPDATE conversations SET draft=?,messages=?,updated_at=? WHERE id=? AND current_task_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND session_id=? AND version=?)',
            )
            .bind(
              '{}',
              JSON.stringify(messages),
              Date.now(),
              id,
              current.id,
              current.id,
              id,
              current.version,
            )
            .run();
          if (!saved.meta.changes)
            throw Error('任务已重置或更新，本次旧结果已丢弃');
          current = await getTask(id, next.taskId);
          emit({
            type: 'complete',
            state: {
              ...responseState(current, messages, await listTasks(id), events),
              modelConfigured: true,
            },
          });
        } catch (cause) {
          emit({
            type: 'error',
            error: signal.aborted
              ? '本次处理已中断或超时，已保存的需求可刷新恢复'
              : cause instanceof Error
                ? cause.message
                : '对话暂时失败',
          });
        } finally {
          if (!cancellation.signal.aborted) controller.close();
        }
      },
      cancel() {
        cancellation.abort();
      },
    });
    const headers = json(
      null,
      200,
      id,
      new URL(request.url).protocol === 'https:',
    ).headers;
    headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    headers.set('X-Accel-Buffering', 'no');
    return new Response(stream, { headers });
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
  } catch (cause) {
    console.error('无法开始新会话', cause);
    return json({ error: '无法开始新会话' }, 503);
  }
}
