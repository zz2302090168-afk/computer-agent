import type { ChatState } from '../backend/agent/conversation';
import { readResponse } from './api';

// 每个页面生命周期只新建一次会话；站内返回重新读取当前数据，不能重放初始空快照。
let initialized: Promise<ChatState> | undefined;
export function loadWorkspace() {
  if (!initialized) {
    initialized = fetch('/api/chat', { method: 'PUT' })
      .then((response) => readResponse<ChatState>(response))
      .catch((error) => {
        initialized = undefined;
        throw error;
      });
    return initialized;
  }
  return initialized
    .then(() => fetch('/api/chat', { cache: 'no-store' }))
    .then((response) => readResponse<ChatState>(response));
}
