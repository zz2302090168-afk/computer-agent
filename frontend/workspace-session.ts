import type { ChatState } from '../backend/agent/conversation';
import { readResponse } from './api';

// 会话只属于当前页面运行期；站内导航复用，完整刷新产生新的标识。
let pageSessionId: string | undefined;
let pending: { id: string; request: Promise<ChatState> } | undefined;
let starting: Promise<ChatState> | undefined;
let lifecycleAttached = false;

export function pageSessionHeaders() {
  pageSessionId ??= crypto.randomUUID();
  if (typeof window !== 'undefined' && !lifecycleAttached) {
    lifecycleAttached = true;
    window.addEventListener('pagehide', () => {
      const id = pageSessionId;
      pageSessionId = undefined;
      pending = undefined;
      if (id)
        void fetch('/api/chat', {
          method: 'DELETE',
          headers: { 'x-page-session': id },
          keepalive: true,
        }).catch(() => {});
    });
  }
  return { 'x-page-session': pageSessionId };
}

export function loadWorkspace() {
  const headers = pageSessionHeaders();
  const id = headers['x-page-session'];
  if (pending?.id === id) return pending.request;
  const request = fetch('/api/chat', { cache: 'no-store', headers })
    .then((response) => readResponse<ChatState>(response))
    .finally(() => {
      if (pending?.request === request) pending = undefined;
    });
  pending = { id, request };
  return request;
}

export function startNewPageSession() {
  if (starting) return starting;
  const headers = pageSessionHeaders();
  const request = (async () => {
    const response = await fetch('/api/chat', { method: 'DELETE', headers });
    if (!response.ok) await readResponse(response);
    if (pageSessionId !== headers['x-page-session'])
      throw Error('本次对话已结束');
    pageSessionId = crypto.randomUUID();
    pending = undefined;
    return loadWorkspace();
  })().finally(() => {
    if (starting === request) starting = undefined;
  });
  starting = request;
  return request;
}
