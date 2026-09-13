import { createChatTrace } from '@/backend/diagnostics/chat-trace';
import { loadCatalog } from '@/backend/db/catalog';
import {
  createPageSession,
  readPageSession,
  updatePageTask,
  updatePageMessages,
  deletePageSession,
} from '@/backend/session/page-session';
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
import { completeRequirements } from '@/backend/agent/conversation-state';
import { auditDelivery } from '@/backend/services/delivery-audit';
import type { Catalog, PcTask } from '@/backend/domain/types';
import type { ChatStreamEvent } from '@/backend/agent/progress';

// 当前页面内重新读取方案仍核对最新商品；不会从数据库恢复对话。
function auditCurrentTask(task: PcTask, catalog: Catalog): PcTask {
  if (!task.result?.plans.length) return task;
  try {
    const requirements = completeRequirements(task.draft);
    return {
      ...task,
      result: {
        ...task.result,
        requirements,
        plans: auditDelivery(task.result.plans, requirements, catalog),
      },
    };
  } catch (cause) {
    return {
      ...task,
      result: null,
      issues: [cause instanceof Error ? cause.message : '当前配置审核未通过'],
      draft: {
        ...task.draft,
        partSelections: {},
        selectionSources: {},
        selectionConfirmationMessageIds: {},
      },
    };
  }
}

function responseState(
  task: PcTask,
  messages: ChatMessage[],
  events: StateEvent[] = [],
): ChatState {
  return {
    draft: task.draft,
    result: task.result,
    task,
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
    assertSameOrigin(request);
    const session = createPageSession(sessionId(request));
    const task = session.task.result?.plans.length
      ? auditCurrentTask(session.task, await loadCatalog())
      : session.task;
    return json(responseState(task, session.messages));
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '页面会话暂时不可用' },
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
    const consultPrebuiltId: unknown = input.consultPrebuiltId;
    if (
      consultPrebuiltId !== undefined &&
      (typeof consultPrebuiltId !== 'string' || !consultPrebuiltId.trim())
    )
      throw Error('咨询的组装整机 ID 无效，请从商品目录重新选择');
    const message = input.message.trim(),
      id = sessionId(request),
      workspace = readPageSession(id),
      messageId = crypto.randomUUID();
    if (input.taskId !== workspace.task.id)
      throw Error('当前对话已结束，请使用新的对话');
    const trace = createChatTrace({
      messageId,
      taskId: workspace.task.id,
      message,
      consultPrebuiltId,
      task: workspace.task,
      messages: workspace.messages,
    });
    const tracedCatalog = async () => {
      const catalog = await loadCatalog();
      trace.record('catalog', catalog);
      return catalog;
    };
    const cancellation = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      cancellation.signal,
      AbortSignal.timeout(300000),
    ]);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        return trace.run(async () => {
          const emit = (event: ChatStreamEvent) => {
            trace.record('stream', event);
            if (!cancellation.signal.aborted)
              controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          };
          try {
            emit({
              type: 'progress',
              progress: {
                scope: 'main',
                label: '读取当前对话与商品目录',
                status: 'running',
              },
            });
            const catalog = await tracedCatalog(),
              task = auditCurrentTask(workspace.task, catalog),
              events: StateEvent[] = [];
            let current = task;
            const onUpdate = async (
              type: StateEvent['type'],
              draft: ChatState['draft'],
              result: ChatState['result'],
            ) => {
              signal.throwIfAborted();
              // 只更新本页面的易失内存，版本检查防止迟到请求覆盖新配置。
              current = updatePageTask(
                id,
                {
                  ...current,
                  name: draft.purpose ? `${draft.purpose}主机` : current.name,
                  draft,
                  result,
                  issues:
                    result && !result.plans.length ? [result.summary] : [],
                },
                current.version,
              ).task;
              trace.record('state', { type, task: current });
              if (type === 'requirements')
                emit({ type: 'requirements', task: current });
              events.push({
                type,
                taskId: current.id,
                version: current.version,
              });
              return current.version;
            };
            const next = await runConversation(
              {
                key: process.env.MODEL_API_KEY,
                base: process.env.MODEL_BASE_URL,
                model: process.env.MODEL_NAME,
              },
              {
                draft: task.draft,
                result: task.result,
                messages: workspace.messages,
                task,
                currentTaskId: task.id,
              },
              message,
              messageId,
              catalog,
              tracedCatalog,
              onUpdate,
              id,
              async () => {},
              (progress) => emit({ type: 'progress', progress }),
              signal,
              {
                key: process.env.EMBEDDING_API_KEY,
                base: process.env.EMBEDDING_BASE_URL,
                model: process.env.EMBEDDING_MODEL,
              },
              consultPrebuiltId,
              (text) => emit({ type: 'text', text }),
            );
            signal.throwIfAborted();
            const saved = updatePageMessages(
              id,
              current.id,
              current.version,
              next.messages.slice(-60),
            );
            emit({
              type: 'complete',
              state: responseState(
                auditCurrentTask(saved.task, await tracedCatalog()),
                saved.messages,
                events,
              ),
            });
          } catch (cause) {
            trace.record('error', cause);
            emit({
              type: 'error',
              error: signal.aborted
                ? '本次处理已中断或超时，可在当前页面继续；刷新会清空本次对话'
                : cause instanceof Error
                  ? cause.message
                  : '对话暂时失败',
            });
          } finally {
            trace.record('end', { aborted: signal.aborted });
            if (!cancellation.signal.aborted) controller.close();
          }
        });
      },
      cancel() {
        trace.record('cancel', {});
        cancellation.abort();
      },
    });
    const headers = json(null).headers;
    headers.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    headers.set('X-Accel-Buffering', 'no');
    return new Response(stream, { headers });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '对话暂时失败' },
      400,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    deletePageSession(sessionId(request));
    return json({ ok: true });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '无法结束对话' },
      400,
    );
  }
}
