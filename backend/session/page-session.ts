import type { ChatMessage } from '../agent/conversation';
import type { PcTask } from '../domain/types';

export type PageSession = {
  id: string;
  task: PcTask;
  messages: ChatMessage[];
};

// 各 API 共享进程内状态；页面 ID 不进入 Cookie、文件或数据库。
const runtime = globalThis as typeof globalThis & {
  pcPageSessions?: Map<string, PageSession>;
};
const sessions = (runtime.pcPageSessions ??= new Map<string, PageSession>());

function requireSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw Error('当前页面会话已结束，请重新开始对话');
  return session;
}

function assertCurrentTask(
  session: PageSession,
  taskId: string,
  expectedVersion: number,
) {
  if (session.task.id !== taskId)
    throw Error('当前页面任务不一致，本次旧结果已丢弃');
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    session.task.version !== expectedVersion
  )
    throw Error('当前方案已更新，本次旧结果已丢弃');
}

export function createPageSession(id: string): PageSession {
  const existing = sessions.get(id);
  if (existing) return structuredClone(existing);
  const session: PageSession = {
    id,
    task: {
      id: crypto.randomUUID(),
      name: '当前主机',
      draft: {},
      result: null,
      issues: [],
      version: 1,
      updatedAt: Date.now(),
    },
    messages: [],
  };
  sessions.set(id, session);
  return structuredClone(session);
}

export function readPageSession(id: string): PageSession {
  return structuredClone(requireSession(id));
}

export function updatePageTask(
  id: string,
  task: PcTask,
  expectedVersion: number,
): PageSession {
  const session = requireSession(id);
  assertCurrentTask(session, task.id, expectedVersion);
  const next: PageSession = {
    ...session,
    task: {
      ...structuredClone(task),
      version: expectedVersion + 1,
      updatedAt: Date.now(),
    },
  };
  sessions.set(id, next);
  return structuredClone(next);
}

export function updatePageMessages(
  id: string,
  taskId: string,
  expectedVersion: number,
  messages: ChatMessage[],
): PageSession {
  const session = requireSession(id);
  assertCurrentTask(session, taskId, expectedVersion);
  const next = { ...session, messages: structuredClone(messages) };
  sessions.set(id, next);
  return structuredClone(next);
}

export function deletePageSession(id: string) {
  return sessions.delete(id);
}
