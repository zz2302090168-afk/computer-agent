import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import type { SupportAction } from '../tools/types';
import { retrieveKnowledge } from '../rag/retrieve';
import { supportKnowledge } from '../../knowledge/support';
import { runConversation } from '../agent/conversation';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';

type Fixture = ReturnType<typeof fixture>;

// 语义分类是测试给定的模型输出；这里只检查结构化授权及售后状态边界。
async function beginTurn(
  f: Fixture,
  content: string,
  supportAction?: SupportAction,
) {
  const messageId = `support-${f.context.messages.length}`;
  f.context.currentMessageId = messageId;
  f.context.messages.push({
    id: messageId,
    role: 'user',
    content,
    taskId: f.context.taskId,
  });
  f.runtime.requestAction = 'pending';
  f.runtime.supportRequest = undefined;
  f.runtime.supportEvidence = undefined;
  f.runtime.supportRetrieval = undefined;
  f.runtime.supportDelivery = undefined;
  const declaration = await executeRegisteredTool(
    'set_request_action',
    {
      action: supportAction ? 'update_support' : 'other',
      sourceMessageId: messageId,
      ...(supportAction ? { supportAction } : {}),
      ...(!supportAction ? { otherTopic: 'support' } : {}),
    },
    f.context,
    f.runtime,
  );
  assert.equal(declaration.operation.failed, false, '本轮结构化动作声明失败');
  return messageId;
}

void test('售后知识按故障分块召回，不混入售前预算资料', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  assert.ok(supportKnowledge.length >= 45);
  for (const [query, topic] of [
    ['显示器无信号黑屏', 'support-no-display'],
    ['完全不开机不通电', 'support-no-power'],
    ['WiFi断网上不了网', 'support-network'],
  ]) {
    const hits = await retrieveKnowledge(embeddingConfig, query, 4, 'support');
    assert.ok(hits.some((hit) => 'topicId' in hit && hit.topicId === topic));
    assert.ok(
      hits.every((hit) => hit.category === 'support' && hit.checkedAt === null),
    );
  }
  assert.ok(
    (await retrieveKnowledge(embeddingConfig, '内存主板兼容')).every(
      (hit) => hit.category !== 'support',
    ),
  );
});

void test('售后保存原话和所选一步，保留售前方案，拒绝未检索/跨任务知识操作', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  const content = '主机风扇转，屏幕无信号';
  const messageId = await beginTurn(f, content, 'continue');
  const before = JSON.stringify(f.runtime.result);
  const step = supportKnowledge.find(
    (item) =>
      item.topicId === 'support-no-display' && item.title.includes('步骤1'),
  )!;
  let output = await executeRegisteredTool(
    'update_support',
    { messageId, action: 'continue', knowledgeId: step.id },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
  await executeRegisteredTool(
    'retrieve_knowledge',
    {
      query: '步骤1 显示器自身工作',
      category: 'support',
      topicId: 'support-no-display',
    },
    f.context,
    f.runtime,
  );
  output = await executeRegisteredTool(
    'update_support',
    { messageId, action: 'continue', knowledgeId: step.id },
    f.context,
    f.runtime,
  );
  // 上一次失败的相同参数会被去重，新的检索必须使该调用可重试。
  assert.equal(output.operation.failed, false);
  assert.equal(output.operation.requirementsChanged, false);
  assert.equal(JSON.stringify(f.runtime.result), before);
  assert.equal(f.saved.at(-1)?.draft.support?.history[0].report, content);
  assert.equal(f.runtime.exploration, undefined);
  output = await executeRegisteredTool(
    'update_support',
    { messageId: 'old', action: 'continue' },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
});

void test('给定否定、条件或入口咨询分类，不允许工具自行升级转人工', async () => {
  for (const content of [
    '不要转人工',
    '如果还不行再转人工',
    '怎么转人工',
    '转人工吗？',
    '黑屏太烦了',
    '不用找人工客服',
  ]) {
    const f = fixture();
    const messageId = await beginTurn(f, content);
    const output = await executeRegisteredTool(
      'update_support',
      { messageId, action: 'handoff' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true, content);
    assert.equal(f.runtime.draft.support, undefined);
    assert.equal(f.saved.length, 0);
  }
});

void test('给定直接、礼貌或省略式人工请求分类后，实际保存人工请求', async () => {
  for (const content of [
    '转人工',
    '请帮我转接人工客服',
    '我要找人工客服',
    '不要排查了，直接转人工',
    '可以帮我转人工吗？',
    '麻烦客服接一下',
    '请帮我转人工，如果需要资料我可以补充',
    '麻烦安排一位客服接手处理',
  ]) {
    const f = fixture();
    const messageId = await beginTurn(f, content, 'handoff');
    const output = await executeRegisteredTool(
      'update_support',
      { messageId, action: 'handoff' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, false, content);
    assert.equal(f.runtime.draft.support?.status, 'handoff_requested');
    assert.equal(f.saved[0]!.draft.support?.history[0]!.report, content);
  }
});

void test('给定尚未恢复或条件询问分类，不能由工具改成恢复或人工请求', async () => {
  for (const content of [
    '还是黑屏，没有恢复正常',
    '如果好了我会告诉你',
    '现在算修好了吗？',
  ]) {
    const f = fixture();
    const messageId = await beginTurn(f, content, 'continue');
    for (const action of ['resolved', 'handoff']) {
      const output = await executeRegisteredTool(
        'update_support',
        { messageId, action },
        f.context,
        f.runtime,
      );
      assert.equal(
        output.operation.failed,
        true,
        `${content} 不得执行 ${action}`,
      );
    }
    assert.equal(f.runtime.draft.support, undefined);
    assert.equal(f.saved.length, 0);
  }
});

void test('给定直接、礼貌或省略式恢复分类，不再依赖原话包含固定短语', async () => {
  for (const content of ['已经恢复正常', '谢谢，问题解决了', '可以用了']) {
    const f = fixture();
    const messageId = await beginTurn(f, content, 'resolved');
    const output = await executeRegisteredTool(
      'update_support',
      { messageId, action: 'resolved' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, false, content);
    assert.equal(f.runtime.draft.support?.status, 'resolved');
    assert.equal(f.saved[0]!.draft.support?.history[0]!.report, content);
  }
});

void test('停止自行排查后仅允许明确人工请求，保存重载后仍禁止其他售后操作', async () => {
  const f = fixture();
  const originalResult = structuredClone(f.runtime.result);
  const step = supportKnowledge.find((item) => item.title.includes('步骤1'))!;
  const stopped = await executeRegisteredTool(
    'update_support',
    { messageId: await beginTurn(f, '电脑有焦味', 'stop'), action: 'stop' },
    f.context,
    f.runtime,
  );
  assert.equal(stopped.operation.failed, false);
  assert.equal(f.runtime.draft.support?.selfServiceStopped, true);
  const assertOtherActionsBlocked = async () => {
    for (const input of [
      { action: 'continue' },
      { action: 'continue', knowledgeId: step.id },
      { action: 'resolved' },
      { action: 'new_issue' },
      { action: 'stop' },
    ] as const) {
      const before = structuredClone(f.runtime.draft);
      const saveCount = f.saved.length;
      const output = await executeRegisteredTool(
        'update_support',
        {
          messageId: await beginTurn(
            f,
            '已经恢复正常，接下来检查另一台电脑',
            input.action,
          ),
          ...input,
        },
        f.context,
        f.runtime,
      );
      assert.equal(output.operation.failed, true, input.action);
      assert.match(output.operation.error ?? '', /售后仅允许.*转人工/);
      assert.deepEqual(f.runtime.draft, before);
      assert.equal(f.saved.length, saveCount);
    }
  };
  await assertOtherActionsBlocked();
  const unauthorized = await executeRegisteredTool(
    'update_support',
    { messageId: await beginTurn(f, '不需要转人工'), action: 'handoff' },
    f.context,
    f.runtime,
  );
  assert.equal(unauthorized.operation.failed, true);
  const handedOff = await executeRegisteredTool(
    'update_support',
    {
      messageId: await beginTurn(f, '请帮我转人工', 'handoff'),
      action: 'handoff',
    },
    f.context,
    f.runtime,
  );
  assert.equal(handedOff.operation.failed, false);
  f.runtime.draft = structuredClone(f.saved.at(-1)!.draft);
  assert.equal(f.runtime.draft.support?.status, 'handoff_requested');
  assert.equal(f.runtime.draft.support?.selfServiceStopped, true);
  await assertOtherActionsBlocked();
  assert.deepEqual(f.runtime.result, originalResult);
});

void test('旧stopped记录同样受保护，转人工时补存停止标记', async () => {
  const f = fixture();
  f.runtime.draft.support = { status: 'stopped', symptom: '进液', history: [] };
  const before = structuredClone(f.runtime.draft);
  const blocked = await executeRegisteredTool(
    'update_support',
    {
      messageId: await beginTurn(f, '另一台电脑开不了机', 'new_issue'),
      action: 'new_issue',
    },
    f.context,
    f.runtime,
  );
  assert.equal(blocked.operation.failed, true);
  assert.deepEqual(f.runtime.draft, before);
  const output = await executeRegisteredTool(
    'update_support',
    { messageId: await beginTurn(f, '请转人工', 'handoff'), action: 'handoff' },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  assert.equal(f.saved.at(-1)!.draft.support?.selfServiceStopped, true);
  assert.equal(f.runtime.draft.support?.symptom, '进液');
});

void test('未停止的售后仍可正常记录、标记恢复和开始全新故障', async () => {
  const f = fixture();
  for (const [action, content, status] of [
    ['continue', '显示器无信号', 'active'],
    ['resolved', '已经恢复正常', 'resolved'],
    ['new_issue', '另一台电脑上不了网', 'active'],
  ] as const) {
    const messageId = await beginTurn(f, content, action);
    const output = await executeRegisteredTool(
      'update_support',
      { messageId, action },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, false);
    assert.equal(f.runtime.draft.support?.status, status);
    assert.equal(f.runtime.draft.support?.selfServiceStopped, undefined);
  }
  assert.equal(f.runtime.draft.support?.symptom, '另一台电脑上不了网');
});

void test('没有本轮售后声明或工具子动作不匹配时不得写入状态', async () => {
  const f = fixture();
  const undeclared = await executeRegisteredTool(
    'update_support',
    { messageId: 'current', action: 'handoff' },
    f.context,
    f.runtime,
  );
  assert.equal(undeclared.operation.failed, true);
  const messageId = await beginTurn(f, '现在仍然黑屏', 'continue');
  const mismatch = await executeRegisteredTool(
    'update_support',
    { messageId, action: 'resolved' },
    f.context,
    f.runtime,
  );
  assert.equal(mismatch.operation.failed, true);
  assert.equal(f.runtime.draft.support, undefined);
  assert.equal(f.saved.length, 0);
});

void test('旧消息和跨任务不能复用已经声明的售后子动作', async () => {
  for (const boundary of ['message', 'task'] as const) {
    const f = fixture();
    const declaredMessageId = await beginTurn(f, '请转人工', 'handoff');
    if (boundary === 'message') {
      f.context.currentMessageId = 'next-user';
      f.context.messages.push({
        id: 'next-user',
        role: 'user',
        content: '先不用了',
        taskId: 'task',
      });
      const oldMessage = await executeRegisteredTool(
        'update_support',
        { messageId: declaredMessageId, action: 'handoff' },
        f.context,
        f.runtime,
      );
      assert.equal(oldMessage.operation.failed, true);
    } else {
      // 模拟任务切换时当前消息归属变化，不能把旧任务授权带到新任务。
      f.context.taskId = 'other-task';
      f.runtime.task = { ...f.runtime.task, id: 'other-task' };
      f.context.messages.find(
        (message) => message.id === declaredMessageId,
      )!.taskId = 'other-task';
    }
    const reused = await executeRegisteredTool(
      'update_support',
      { messageId: f.context.currentMessageId, action: 'handoff' },
      f.context,
      f.runtime,
    );
    assert.equal(reused.operation.failed, true, boundary);
    assert.equal(f.runtime.draft.support, undefined);
    assert.equal(f.saved.length, 0);
  }
});

void test('给定模型售后子动作后，无预算对话执行知识检索和记录且不增加分类调用', async (t) => {
  const f = fixture();
  const step = supportKnowledge.find(
    (item) =>
      item.topicId === 'support-no-display' && item.title.includes('步骤1'),
  )!;
  let calls = 0;
  let modelCalls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options: RequestInit) => {
      if (String(url).endsWith('/embeddings'))
        return embeddingFetch(url, options);
      modelCalls++;
      const request = JSON.parse(options.body as string);
      if (request.tools[0]?.function.name === 'set_request_action')
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'request-action', type: 'function', function: { name: 'set_request_action', arguments: JSON.stringify({ action: 'update_support', supportAction: 'continue', sourceMessageId: 'current' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      assert.ok(
        request.tools.some(
          (tool: { function: { name: string } }) =>
            tool.function.name === 'update_support',
        ),
      );
      assert.ok(
        !request.tools.some(
          (tool: { function: { name: string } }) =>
            tool.function.name === 'recommend_pc',
        ),
      );
      const index = calls++;
      if (index === 2)
        return new Response(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '先检查显示器菜单是否能正常出现，再告诉我结果。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      const name = index === 0 ? 'retrieve_knowledge' : 'update_support';
      const args =
        name === 'retrieve_knowledge'
          ? {
              query: '显示器自身工作',
              category: 'support',
              topicId: 'support-no-display',
            }
          : { messageId: 'current', action: 'continue', knowledgeId: step.id };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  );
  const result = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: {},
      result: null,
      task: { ...f.runtime.task, draft: {}, result: null },
      currentTaskId: 'task',
      messages: [],
    },
    '风扇转但是屏幕无信号',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    embeddingConfig,
  );
  assert.equal(calls, 3);
  assert.equal(
    modelCalls,
    4,
    '售后子动作应与主动作同次声明，不增加单独分类请求',
  );
  assert.match(result.messages.at(-1)!.content, /菜单/);
  assert.doesNotMatch(result.messages.at(-1)!.content, /预算是多少/);
  assert.equal(result.draft.support?.status, 'active');
  assert.equal(result.result, null);
});
