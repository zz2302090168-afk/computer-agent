import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkspace } from '../../frontend/workspace-session';

void test('进入目录再返回读取最新聊天，初始化并发只新建一次会话', async (t) => {
  const requests: string[] = [];
  let current = {
    draft: {},
    result: null,
    messages: [] as { role: string; content: string }[],
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      requests.push(options?.method ?? 'GET');
      return new Response(JSON.stringify(current), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );
  await Promise.all([loadWorkspace(), loadWorkspace()]);
  assert.equal(requests.filter((method) => method === 'PUT').length, 1);
  current = {
    ...current,
    messages: [
      { role: 'user', content: '9000元游戏主机' },
      { role: 'assistant', content: '已记录预算和用途' },
    ],
  };
  const restored = await loadWorkspace();
  assert.deepEqual(restored.messages, current.messages);
  assert.equal(requests.at(-1), 'GET');
  assert.equal(requests.filter((method) => method === 'PUT').length, 1);
});
