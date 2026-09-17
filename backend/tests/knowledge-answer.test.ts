import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';
import { availableTools, runConversation } from '../agent/conversation';
import { executeRegisteredTool } from '../tools/registry';
import { completedSalesReply } from '../agent/sales-reply';
import { knowledge } from '../../knowledge/library';

const memoryBlock = knowledge.find((block) => block.id === 'compat-memory')!;

async function setup(knowledgeOnly = true) {
  const f = fixture();
  f.runtime.requestAction = 'pending';
  const action = await executeRegisteredTool(
    'set_request_action',
    {
      action: 'retrieve_knowledge',
      sourceMessageId: 'current',
      knowledgeOnly,
    },
    f.context,
    f.runtime,
  );
  assert.equal(action.operation.failed, false);
  return f;
}

async function retrieve(f: ReturnType<typeof fixture>) {
  return executeRegisteredTool(
    'retrieve_knowledge',
    { query: 'DDR4 DDR5 内存主板', category: 'sales' },
    f.context,
    f.runtime,
  );
}

function answer(
  f: ReturnType<typeof fixture>,
  knowledgeIds: string[],
  coverage = 'complete',
  extra = {},
) {
  return executeRegisteredTool(
    'answer_knowledge',
    { knowledgeIds, coverage, ...extra },
    f.context,
    f.runtime,
  );
}

void test('实际本轮检索后仅按完整知识块原文与来源答复，保留否定和适用条件', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = await setup();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  const result = await retrieve(f);
  assert.equal(result.operation.failed, false);
  assert.ok(f.runtime.knowledgeEvidence?.blocks.has(memoryBlock.id));
  const delivered = await answer(f, [memoryBlock.id]);
  assert.equal(delivered.operation.failed, false);
  const reply = completedSalesReply(delivered)!;
  assert.ok(reply.includes(memoryBlock.content));
  assert.ok(
    reply.includes(`来源：[${memoryBlock.title}](${memoryBlock.source})`),
  );
  assert.match(reply, /不能互插/);
  assert.match(reply, /不代表一块主板同时支持/);
  assert.equal(f.runtime.knowledgeAnswerReady, true);
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
  assert.equal(f.saved.length, 0);
});

for (const scenario of [
  'before-retrieval',
  'unknown-id',
  'duplicate-id',
  'old-task',
  'old-message',
  'custom-fact',
] as const)
  void test(`证据答复拒绝不可信引用或自填正文：${scenario}`, async (t) => {
    t.mock.method(globalThis, 'fetch', embeddingFetch);
    const f = await setup();
    if (scenario !== 'before-retrieval') await retrieve(f);
    if (scenario === 'old-task')
      f.runtime.knowledgeEvidence!.taskId = 'previous-task';
    if (scenario === 'old-message')
      f.runtime.knowledgeEvidence!.messageId = 'previous-message';
    const ids =
      scenario === 'unknown-id'
        ? ['not-retrieved']
        : scenario === 'duplicate-id'
          ? [memoryBlock.id, memoryBlock.id]
          : [memoryBlock.id];
    const result = await answer(
      f,
      ids,
      'complete',
      scenario === 'custom-fact' ? { displayReply: 'DDR4和DDR5可以互插' } : {},
    );
    assert.equal(result.operation.failed, true);
    assert.equal(completedSalesReply(result), undefined);
    assert.notEqual(f.runtime.knowledgeAnswerReady, true);
    assert.equal(f.saved.length, 0);
  });

void test('unsupported须本轮实际检索后空ID，complete和partial不得使用空ID', async () => {
  const f = await setup();
  f.context.embeddingConfig = {};
  const premature = await answer(f, [], 'unsupported');
  assert.equal(premature.operation.failed, true);
  const retrieval = await retrieve(f);
  assert.equal(retrieval.operation.failed, false);
  assert.equal(f.runtime.knowledgeEvidence?.blocks.size, 0);
  for (const coverage of ['complete', 'partial']) {
    const invalid = await answer(f, [], coverage);
    assert.equal(invalid.operation.failed, true);
  }
  const unsupported = await answer(f, [], 'unsupported');
  assert.equal(unsupported.operation.failed, false);
  assert.match(completedSalesReply(unsupported)!, /资料不足以回答/);
  assert.equal(f.runtime.knowledgeAnswerReady, true);
});

void test('partial保留原文并注明未覆盖部分，unsupported不能夹带知识ID', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = await setup();
  await retrieve(f);
  const invalid = await answer(f, [memoryBlock.id], 'unsupported');
  assert.equal(invalid.operation.failed, true);
  const partial = await answer(f, [memoryBlock.id], 'partial');
  assert.equal(partial.operation.failed, false);
  assert.ok(completedSalesReply(partial)!.includes(memoryBlock.content));
  assert.match(completedSalesReply(partial)!, /其余问题本次资料未说明/);
});

void test('纯知识仅开放检索和证据答复；knowledgeOnly=false保留原目录查询能力', async () => {
  const pure = await setup();
  assert.deepEqual(
    availableTools(pure.runtime)
      .map((tool) => tool.function.name)
      .sort(),
    ['answer_knowledge', 'retrieve_knowledge'],
  );
  const forbidden = await executeRegisteredTool(
    'search_catalog',
    { category: 'cpu' },
    pure.context,
    pure.runtime,
  );
  assert.equal(forbidden.operation.failed, true);
  const compound = await setup(false);
  assert.deepEqual(
    availableTools(compound.runtime)
      .map((tool) => tool.function.name)
      .sort(),
    ['retrieve_knowledge', 'search_catalog'],
  );
  const allowed = await executeRegisteredTool(
    'search_catalog',
    { category: 'cpu' },
    compound.context,
    compound.runtime,
  );
  assert.equal(allowed.operation.failed, false);
  const wrongAnswer = await answer(compound, [], 'unsupported');
  assert.equal(wrongAnswer.operation.failed, true);
});

void test('答复后再检索使完成标记失效，必须重新选择答复', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = await setup();
  await retrieve(f);
  assert.equal((await answer(f, [memoryBlock.id])).operation.failed, false);
  assert.equal(f.runtime.knowledgeAnswerReady, true);
  await retrieve(f);
  assert.equal(f.runtime.knowledgeAnswerReady, false);
  assert.equal(
    (await answer(f, [memoryBlock.id], 'partial')).operation.failed,
    false,
  );
  assert.equal(f.runtime.knowledgeAnswerReady, true);
});

void test('先失败的知识ID在本轮真正检索返回后可再次提交，不被失败缓存挡住', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = await setup();
  f.context.embeddingConfig = {};
  await retrieve(f);
  const before = await answer(f, [memoryBlock.id]);
  assert.equal(before.operation.failed, true);
  f.context.embeddingConfig = {
    ...embeddingConfig,
    model: 'knowledge-answer-retry',
  };
  await retrieve(f);
  assert.ok(f.runtime.knowledgeEvidence?.blocks.has(memoryBlock.id));
  const after = await answer(f, [memoryBlock.id]);
  assert.equal(after.operation.failed, false);
  assert.ok(completedSalesReply(after)!.includes(memoryBlock.content));
});

function modelResponse(name?: string, args?: unknown) {
  const delta = name
    ? {
        tool_calls: [
          {
            index: 0,
            id: `call-${name}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { content: '模型编造：DDR4和DDR5都能互插，所有组合都有性能保证。' };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

for (const unavailable of [false, true])
  void test(`模拟知识问答交付工具原文，最终编造及流式文字不泄漏：unavailable=${unavailable}`, async (t) => {
    const f = fixture();
    let calls = 0;
    const streamed: string[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (url: unknown, options?: RequestInit) => {
        if (String(url).includes('/embeddings'))
          return unavailable
            ? new Response('', { status: 503 })
            : embeddingFetch(url, options);
        calls++;
        if (calls === 1)
          return modelResponse('set_request_action', {
            action: 'retrieve_knowledge',
            sourceMessageId: 'current',
            knowledgeOnly: true,
          });
        if (calls === 2)
          return modelResponse('retrieve_knowledge', {
            query: 'DDR4 DDR5 内存主板',
            category: 'sales',
          });
        if (calls === 3)
          return modelResponse('answer_knowledge', {
            knowledgeIds: unavailable ? [] : [memoryBlock.id],
            coverage: unavailable ? 'unsupported' : 'complete',
          });
        return modelResponse();
      },
    );
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      '解释DDR4和DDR5能否混用，只问知识，不改配置',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
      undefined,
      undefined,
      {
        ...embeddingConfig,
        model: unavailable
          ? 'knowledge-answer-failed-model'
          : 'knowledge-answer-success-model',
      },
      undefined,
      (value) => streamed.push(value),
    );
    assert.equal(calls, 4);
    const reply = result.messages.at(-1)!.content;
    if (unavailable) {
      assert.match(reply, /资料不足以回答/);
      assert.ok(!reply.includes('数据库已有规格与程序审核结果'));
    }
    else {
      assert.ok(reply.includes(memoryBlock.content));
      assert.ok(reply.includes(memoryBlock.source!));
    }
    assert.ok(!reply.includes('模型编造'));
    assert.ok(!reply.includes('所有组合都有性能保证'));
    assert.ok(streamed.every((text) => !text.includes('模型编造')));
    assert.deepEqual(result.result, f.runtime.result);
    assert.equal(f.saved.length, 0);
  });

void test('检索后提前自由答复不能交付，强制证据答复且仍最多修正两次', async (t) => {
  for (const completes of [true, false]) {
    const f = fixture();
    const streamed: string[] = [];
    let calls = 0;
    let repairs = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (url: unknown, options?: RequestInit) => {
        if (String(url).includes('/embeddings'))
          return embeddingFetch(url, options);
        calls++;
        if (calls === 1)
          return modelResponse('set_request_action', {
            action: 'retrieve_knowledge',
            sourceMessageId: 'current',
            knowledgeOnly: true,
          });
        if (calls === 2)
          return modelResponse('retrieve_knowledge', {
            query: 'DDR4 DDR5 内存主板',
            category: 'sales',
          });
        if (calls >= 4 && (!completes || calls === 4)) {
          const request = JSON.parse(options!.body as string) as {
            tool_choice: string;
            tools: { function: { name: string } }[];
            messages: { role: string; content?: string }[];
          };
          assert.equal(request.tool_choice, 'required');
          assert.ok(
            request.tools.some(
              (tool) => tool.function.name === 'answer_knowledge',
            ),
          );
          assert.ok(
            request.messages.some(
              (message) =>
                message.role === 'system' &&
                message.content?.includes('必要操作尚未完成'),
            ),
          );
          repairs++;
          if (completes)
            return modelResponse('answer_knowledge', {
              knowledgeIds: [memoryBlock.id],
              coverage: 'complete',
            });
        }
        return modelResponse();
      },
    );
    const run = runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      '只解释DDR4与DDR5能否混用，不操作配置',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
      undefined,
      undefined,
      { ...embeddingConfig, model: 'knowledge-answer-early-text' },
      undefined,
      (value) => streamed.push(value),
    );
    if (completes) {
      const result = await run;
      const reply = result.messages.at(-1)!.content;
      assert.ok(reply.includes(memoryBlock.content));
      assert.ok(!reply.includes('模型编造'));
      assert.equal(repairs, 1);
    } else {
      await assert.rejects(run, /模型尚未执行完/);
      assert.equal(repairs, 2);
    }
    assert.equal(calls, 5);
    assert.ok(streamed.every((text) => !text.includes('模型编造')));
    assert.equal(f.saved.length, 0);
  }
});
