import test from 'node:test';
import assert from 'node:assert/strict';

async function loadPageModule() {
  const url = new URL('../../frontend/workspace-session.ts', import.meta.url);
  url.searchParams.set('page', crypto.randomUUID());
  const workspace: typeof import('../../frontend/workspace-session') =
    await import(url.href);
  return workspace;
}

void test('初始化并发只读取一次会话，进入目录再返回读取最新聊天', async (t) => {
  const { loadWorkspace, pageSessionHeaders } = await loadPageModule();
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
      assert.equal(options?.cache, 'no-store');
      assert.deepEqual(options?.headers, pageSessionHeaders());
      return Response.json(current);
    },
  );
  const first = loadWorkspace();
  const concurrent = loadWorkspace();
  await Promise.all([first, concurrent]);
  assert.equal(first, concurrent);
  assert.deepEqual(requests, ['GET']);
  current = {
    ...current,
    messages: [
      { role: 'user', content: '9000元游戏主机' },
      { role: 'assistant', content: '已记录预算和用途' },
    ],
  };
  const restored = await loadWorkspace();
  assert.deepEqual(restored.messages, current.messages);
  assert.deepEqual(requests, ['GET', 'GET']);
});

void test('完整刷新使用全新页面标识，不带回之前的需求、方案和聊天', async (t) => {
  const current = {
    currentTaskId: 'task-with-build',
    draft: { budget: 9000, purpose: '游戏' },
    result: { plans: [{ id: 'saved-plan' }] },
    messages: [{ role: 'user', content: '帮我解释已经选好的配置' }],
  };
  const empty = { draft: {}, result: null, messages: [] };
  const sessions = new Map<string, unknown>();
  const requests: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      assert.equal(options?.method ?? 'GET', 'GET');
      const id = new Headers(options?.headers).get('x-page-session')!;
      requests.push(id);
      return Response.json(sessions.get(id) ?? empty);
    },
  );
  const beforeRefresh = await loadPageModule();
  sessions.set(beforeRefresh.pageSessionHeaders()['x-page-session'], current);
  assert.deepEqual(await beforeRefresh.loadWorkspace(), current);
  const afterRefresh = await loadPageModule();
  assert.notEqual(beforeRefresh, afterRefresh);
  assert.deepEqual(await afterRefresh.loadWorkspace(), empty);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);
});

void test('会话读取失败后重试仍读取当前页面临时状态', async (t) => {
  const { loadWorkspace, pageSessionHeaders } = await loadPageModule();
  const headers = pageSessionHeaders();
  let attempts = 0;
  const current = { draft: { budget: 9000 }, result: null, messages: [] };
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      assert.equal(options?.method ?? 'GET', 'GET');
      assert.deepEqual(options?.headers, headers);
      attempts++;
      return attempts === 1
        ? Response.json({ error: '临时会话暂不可用' }, { status: 503 })
        : Response.json(current);
    },
  );
  await assert.rejects(loadWorkspace(), /临时会话暂不可用/);
  assert.deepEqual(await loadWorkspace(), current);
  assert.equal(attempts, 2);
});

void test('新对话先释放旧标识，迟到的旧读取不影响新读取的并发合并', async (t) => {
  const page = await loadPageModule();
  const requests: { method: string; id: string }[] = [];
  let finishOld!: (response: Response) => void;
  let finishNew!: (response: Response) => void;
  let newLoadStarted!: () => void;
  const newLoading = new Promise<void>((resolve) => {
    newLoadStarted = resolve;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const method = options?.method ?? 'GET';
      const id = new Headers(options?.headers).get('x-page-session')!;
      requests.push({ method, id });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (requests.length === 1)
        return new Promise<Response>((resolve) => {
          finishOld = resolve;
        });
      newLoadStarted();
      return new Promise<Response>((resolve) => {
        finishNew = resolve;
      });
    },
  );
  const oldLoad = page.loadWorkspace();
  const newSession = page.startNewPageSession();
  assert.equal(page.startNewPageSession(), newSession);
  await newLoading;
  const pendingNew = page.loadWorkspace();
  finishOld(Response.json({ messages: [{ role: 'user', content: '旧消息' }] }));
  await oldLoad;
  assert.equal(page.loadWorkspace(), pendingNew);
  const empty = { draft: {}, result: null, messages: [] };
  finishNew(Response.json(empty));
  assert.deepEqual(await newSession, empty);
  assert.deepEqual(
    requests.map((request) => request.method),
    ['GET', 'DELETE', 'GET'],
  );
  assert.equal(requests[0].id, requests[1].id);
  assert.notEqual(requests[1].id, requests[2].id);
});

void test('释放旧会话失败时保留原页面标识，不伪装已开始新对话', async (t) => {
  const page = await loadPageModule();
  const headers = page.pageSessionHeaders();
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      assert.equal(options?.method, 'DELETE');
      assert.deepEqual(options.headers, headers);
      return Response.json({ error: '暂时无法结束本次对话' }, { status: 503 });
    },
  );
  await assert.rejects(page.startNewPageSession(), /暂时无法结束/);
  assert.deepEqual(page.pageSessionHeaders(), headers);
});

void test('仅页面离开事件释放临时会话，重复初始化不删除且不重复注册清理', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const browser = new EventTarget();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: browser,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const page = await loadPageModule();
  const requests: RequestInit[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      requests.push(options);
      return Response.json({ draft: {}, result: null, messages: [] });
    },
  );
  await Promise.all([page.loadWorkspace(), page.loadWorkspace()]);
  const oldHeaders = page.pageSessionHeaders();
  await page.loadWorkspace();
  assert.equal(
    requests.filter((request) => request.method === 'DELETE').length,
    0,
  );
  browser.dispatchEvent(new Event('pagehide'));
  const releases = requests.filter((request) => request.method === 'DELETE');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].keepalive, true);
  assert.deepEqual(releases[0].headers, oldHeaders);
  assert.notDeepEqual(page.pageSessionHeaders(), oldHeaders);
});
