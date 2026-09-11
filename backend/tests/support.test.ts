import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import { explicitlyRequestsHuman } from '../tools/support';
import { retrieveKnowledge } from '../rag/retrieve';
import { supportKnowledge } from '../../knowledge/support';
import { runConversation } from '../agent/conversation';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';

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
  f.context.messages[0].content = '主机风扇转，屏幕无信号';
  const before = JSON.stringify(f.runtime.result);
  const step = supportKnowledge.find(
    (item) =>
      item.topicId === 'support-no-display' && item.title.includes('步骤1'),
  )!;
  let output = await executeRegisteredTool(
    'update_support',
    { messageId: 'current', action: 'continue', knowledgeId: step.id },
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
    { messageId: 'current', action: 'continue', knowledgeId: step.id },
    f.context,
    f.runtime,
  );
  // 上一次失败的相同参数会被去重，新的检索必须使该调用可重试。
  assert.equal(output.operation.failed, false);
  assert.equal(output.operation.requirementsChanged, false);
  assert.equal(JSON.stringify(f.runtime.result), before);
  assert.equal(
    f.saved.at(-1)?.draft.support?.history[0].report,
    f.context.messages[0].content,
  );
  assert.equal(f.runtime.exploration, undefined);
  output = await executeRegisteredTool(
    'update_support',
    { messageId: 'old', action: 'continue' },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
});

void test('人工请求仅接受当前明确指令，暂停和未恢复不误标已解决', async () => {
  for (const text of [
    '不要转人工',
    '如果还不行再转人工',
    '怎么转人工',
    '转人工吗？',
    '黑屏太烦了',
    '不用找人工客服',
  ])
    assert.equal(explicitlyRequestsHuman(text), false);
  for (const text of [
    '转人工',
    '请帮我转接人工客服',
    '我要找人工客服',
    '不要排查了，直接转人工',
    '可以帮我转人工吗？',
  ])
    assert.equal(explicitlyRequestsHuman(text), true);
  const f = fixture();
  f.context.messages[0].content = '还是黑屏，没有恢复正常';
  assert.equal(
    (
      await executeRegisteredTool(
        'update_support',
        { messageId: 'current', action: 'resolved' },
        f.context,
        f.runtime,
      )
    ).operation.failed,
    true,
  );
  assert.equal(
    (
      await executeRegisteredTool(
        'update_support',
        { messageId: 'current', action: 'handoff' },
        f.context,
        f.runtime,
      )
    ).operation.failed,
    true,
  );
  await executeRegisteredTool(
    'update_support',
    { messageId: 'current', action: 'stop' },
    f.context,
    f.runtime,
  );
  assert.equal(f.runtime.draft.support?.status, 'stopped');
  f.context.currentMessageId = 'human';
  f.context.messages.push({
    id: 'human',
    role: 'user',
    content: '转人工',
    taskId: 'task',
  });
  assert.equal(
    (
      await executeRegisteredTool(
        'update_support',
        { messageId: 'human', action: 'handoff' },
        f.context,
        f.runtime,
      )
    ).operation.failed,
    false,
  );
  assert.equal(f.runtime.draft.support?.status, 'handoff_requested');
});

void test('无预算的真实对话循环开放售后工具，并由模型生成最终回复', async (t) => {
  const f = fixture();
  const step = supportKnowledge.find(
    (item) =>
      item.topicId === 'support-no-display' && item.title.includes('步骤1'),
  )!;
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options: RequestInit) => {
      if (String(url).endsWith('/embeddings')) return embeddingFetch(url, options);
      const request = JSON.parse(options.body as string);
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
  assert.match(result.messages.at(-1)!.content, /菜单/);
  assert.doesNotMatch(result.messages.at(-1)!.content, /预算是多少/);
  assert.equal(result.draft.support?.status, 'active');
  assert.equal(result.result, null);
});
