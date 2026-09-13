import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { ChatMessage } from '../agent/conversation';
import { json, sessionId } from '../api/http';
import {
  createPageSession,
  deletePageSession,
  readPageSession,
  updatePageMessages,
  updatePageTask,
} from '../session/page-session';

function createSession(t: TestContext) {
  const id = crypto.randomUUID();
  t.after(() => {
    deletePageSession(id);
  });
  return createPageSession(id);
}

void test('页面身份只接受临时请求头，旧Cookie不能恢复会话且响应不写Cookie', () => {
  const id = crypto.randomUUID();
  assert.equal(
    sessionId(
      new Request('http://localhost/api/chat', {
        headers: { 'x-page-session': id },
      }),
    ),
    id,
  );
  const invalidHeaders: HeadersInit[] = [
    {},
    { cookie: `pc_session=${id}` },
    { 'x-page-session': 'invalid' },
  ];
  for (const headers of invalidHeaders)
    assert.throws(
      () => sessionId(new Request('http://localhost/api/chat', { headers })),
      /页面会话无效/,
    );
  const response = json({ ok: true });
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

void test('同一页面连续使用当前状态，新页面从空白开始且互相隔离', (t) => {
  const first = createSession(t);
  const updated = updatePageTask(
    first.id,
    { ...first.task, draft: { budget: 9000, purpose: '游戏' } },
    first.task.version,
  );
  const messages: ChatMessage[] = [{ role: 'user', content: '9000元游戏主机' }];
  updatePageMessages(first.id, first.task.id, updated.task.version, messages);
  const samePage = createPageSession(first.id);
  assert.equal(samePage.task.id, first.task.id);
  assert.equal(samePage.task.draft.budget, 9000);
  assert.deepEqual(samePage.messages, messages);

  const nextPage = createSession(t);
  assert.notEqual(nextPage.id, first.id);
  assert.notEqual(nextPage.task.id, first.task.id);
  assert.equal(nextPage.task.name, '当前主机');
  assert.equal(nextPage.task.version, 1);
  assert.deepEqual(nextPage.task.draft, {});
  assert.equal(nextPage.task.result, null);
  assert.deepEqual(nextPage.task.issues, []);
  assert.deepEqual(nextPage.messages, []);
  assert.equal(readPageSession(first.id).task.draft.budget, 9000);
});

void test('读写都复制状态，调用方修改输入或返回值不能绕过版本提交', (t) => {
  const session = createSession(t);
  session.task.issues.push('外部修改');
  session.messages.push({ role: 'assistant', content: '外部修改' });
  const task = readPageSession(session.id).task;
  assert.deepEqual(task.issues, []);
  assert.deepEqual(readPageSession(session.id).messages, []);

  const brandPreferences = { gpu: '测试品牌' };
  task.draft = { budget: 9000, brandPreferences };
  const updated = updatePageTask(session.id, task, task.version);
  brandPreferences.gpu = '篡改输入';
  updated.task.draft.brandPreferences!.gpu = '篡改返回值';
  const read = readPageSession(session.id);
  assert.equal(read.task.draft.brandPreferences?.gpu, '测试品牌');
  read.task.draft.brandPreferences!.gpu = '篡改读取值';
  assert.equal(
    readPageSession(session.id).task.draft.brandPreferences?.gpu,
    '测试品牌',
  );

  const messages: ChatMessage[] = [
    { role: 'assistant', content: '说明', toolsUsed: ['查询商品'] },
  ];
  const withMessages = updatePageMessages(
    session.id,
    task.id,
    updated.task.version,
    messages,
  );
  messages[0]!.toolsUsed!.push('篡改输入');
  withMessages.messages[0]!.toolsUsed!.push('篡改返回值');
  withMessages.task.draft.budget = 1;
  const stored = readPageSession(session.id);
  assert.deepEqual(stored.messages[0]?.toolsUsed, ['查询商品']);
  assert.equal(stored.task.draft.budget, 9000);
});

void test('同版本并发提交只能成功一次，迟到的方案不能覆盖新版本', async (t) => {
  const session = createSession(t);
  const attempts = await Promise.allSettled(
    [9000, 10000].map((budget) =>
      Promise.resolve().then(() =>
        updatePageTask(
          session.id,
          { ...session.task, draft: { budget } },
          session.task.version,
        ),
      ),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    attempts.filter((result) => result.status === 'rejected').length,
    1,
  );
  const current = readPageSession(session.id);
  assert.equal(current.task.version, 2);
  assert.equal(current.task.draft.budget, 9000);
  assert.throws(
    () => updatePageTask(session.id, session.task, session.task.version),
    /当前方案已更新/,
  );
  assert.equal(readPageSession(session.id).task.draft.budget, 9000);
});

void test('消息写回必须匹配当前任务和版本，失败不会覆盖已有对话', (t) => {
  const session = createSession(t);
  const messages: ChatMessage[] = [{ role: 'user', content: '当前对话' }];
  updatePageMessages(
    session.id,
    session.task.id,
    session.task.version,
    messages,
  );
  const updated = updatePageTask(
    session.id,
    session.task,
    session.task.version,
  );
  for (const [taskId, version] of [
    [session.task.id, session.task.version],
    ['另一页的任务', updated.task.version],
  ] as const)
    assert.throws(() =>
      updatePageMessages(session.id, taskId, version, [
        { role: 'assistant', content: '迟到回复' },
      ]),
    );
  for (const version of [0, -1, 1.5, Infinity])
    assert.throws(() => updatePageTask(session.id, updated.task, version));
  assert.deepEqual(readPageSession(session.id).messages, messages);
  assert.equal(readPageSession(session.id).task.version, updated.task.version);
});

void test('页面会话删除后拒绝读取及迟到写回，不会自动恢复旧状态', (t) => {
  const session = createSession(t);
  assert.equal(deletePageSession(session.id), true);
  assert.throws(() => readPageSession(session.id), /会话已结束/);
  assert.throws(
    () => updatePageTask(session.id, session.task, session.task.version),
    /会话已结束/,
  );
  assert.throws(
    () => updatePageMessages(session.id, session.task.id, 1, []),
    /会话已结束/,
  );
  const restarted = createPageSession(session.id);
  assert.notEqual(restarted.task.id, session.task.id);
  assert.throws(
    () => updatePageTask(session.id, session.task, 1),
    /任务不一致/,
  );
  assert.throws(
    () => updatePageMessages(session.id, session.task.id, 1, []),
    /任务不一致/,
  );
  assert.deepEqual(readPageSession(session.id).task.draft, {});
  assert.deepEqual(readPageSession(session.id).messages, []);
});
