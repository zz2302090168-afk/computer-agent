import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';
import {
  replacementContinuation,
  updateReplacementContinuations,
  type ReplacementContinuation,
} from '../agent/replacement-continuation';
import type { ModelMessage } from '../agent/chat-model';
import { executeRegisteredTool } from '../tools/registry';

function response(
  content: string | null,
  name?: string,
  args?: unknown,
  followup?: unknown,
) {
  return new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: name
            ? {
                tool_calls: (followup ? [args, followup] : [args]).map(
                  (argumentsValue, index) => ({
                    index,
                    id: crypto.randomUUID(),
                    type: 'function',
                    function: {
                      name,
                      arguments: JSON.stringify(argumentsValue),
                    },
                  }),
                ),
              }
            : { content },
          finish_reason: name ? 'tool_calls' : 'stop',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

const cases = [
  {
    name: '空页后沿原条件查询到合格候选',
    prices: [900, 960, 980],
    expectedPages: 2,
  },
  { name: '全部空页查完如实收尾', prices: [900, 910, 920], expectedPages: 3 },
  {
    name: '达到既有16轮限制如实报告尚未查完',
    prices: Array(40).fill(900) as number[],
    expectedPages: 14,
    limited: true,
  },
  { name: '第一页有候选就不自动翻页', prices: [960, 980], expectedPages: 1 },
  {
    name: '同批次下一页已命中不重查旧待办',
    prices: [900, 960, 980],
    expectedPages: 2,
    batch: 'hit',
  },
  {
    name: '同批次后续明确page取消旧待办',
    prices: [900, 910, 960],
    expectedPages: 2,
    batch: 'page',
  },
  {
    name: '用户只查指定空页时不自动翻页',
    prices: [900, 910, 960],
    expectedPages: 1,
    scope: 'page',
    offset: 1,
  },
  {
    name: '降序查询继续保留排序',
    prices: [1100, 1000, 980],
    expectedPages: 2,
    sort: 'price_desc',
  },
] as const;

for (const example of cases)
  void test(example.name, async (t) => {
    const f = fixture();
    f.catalog.parts = f.catalog.parts.filter(
      (part) => part.id === part.category || part.id === 'gpu-upper',
    );
    const gpu = f.catalog.parts.find((part) => part.id === 'gpu')!;
    for (const [index, price] of example.prices.entries())
      f.catalog.parts.push({
        ...structuredClone(gpu),
        id: `page-${index}`,
        name: `分页显卡${index}`,
        price,
        specs: {
          ...gpu.specs,
          length: price < 950 || price > 1000 ? 450 : 300,
        },
      });
    const sort = 'sort' in example ? example.sort : 'price_asc';
    const offset = 'offset' in example ? example.offset : 0;
    const scope = 'scope' in example ? example.scope : 'until_candidate';
    const args = {
      planId: 'plan-1',
      category: 'gpu',
      brand: '测试品牌',
      color: '黑色',
      modelKeyword: '分页显卡',
      priceRelation: 'any',
      totalPriceRelation: 'any',
      limit: 1,
      offset,
      sort,
      searchScope: scope,
    };
    let modelCalls = 0,
      queries = 0;
    let finalContext: ModelMessage[] = [];
    const streamed: string[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options: RequestInit) => {
        modelCalls++;
        if (modelCalls === 1)
          return response(null, 'set_request_action', {
            action: 'find_replacements',
            sourceMessageId: 'current',
          });
        if (modelCalls === 2)
          return response(
            null,
            'find_replacements',
            args,
            'batch' in example
              ? {
                  ...args,
                  offset: 1,
                  searchScope:
                    example.batch === 'page' ? 'page' : 'until_candidate',
                }
              : undefined,
          );
        assert.equal(typeof options.body, 'string');
        finalContext = JSON.parse(options.body as string).messages;
        return response('整个目录没有商品了。');
      },
    );
    const before = structuredClone({
      draft: f.runtime.draft,
      result: f.runtime.result,
    });
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      { ...before, task: f.runtime.task, currentTaskId: 'task', messages: [] },
      scope === 'page'
        ? '只查第二页，不继续翻页，只给替换预览'
        : '查找符合条件的显卡替换预览，不实际替换',
      'current',
      f.catalog,
      async () => {
        queries++;
        return f.catalog;
      },
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
      undefined,
      undefined,
      undefined,
      undefined,
      (value) => streamed.push(value),
    );
    const answer = result.messages.at(-1)!.content;
    const recorded = result.messages.at(-1)!.replacementQueries!;
    const outputs = recorded
      .filter((entry) => entry.role === 'tool')
      .map((entry) => JSON.parse(entry.content!).data);
    assert.equal(queries, example.expectedPages, JSON.stringify(outputs));
    assert.equal(outputs.length, example.expectedPages);
    assert.deepEqual(
      outputs.map((output) => output.offset),
      Array.from({ length: example.expectedPages }, (_, i) => offset + i),
    );
    for (const output of outputs) {
      assert.equal(output.planId, 'plan-1');
      assert.equal(output.query[0].brand, '测试品牌');
      assert.equal(output.query[0].modelKeyword, '分页显卡');
      assert.equal(output.query[0].color, '黑色');
      assert.equal(output.query[0].priceRelation, 'any');
      assert.equal(output.totalPriceRelation, 'any');
    }
    assert.deepEqual({ draft: result.draft, result: result.result }, before);
    assert.equal(f.saved.length, 0);
    assert.ok(!answer.includes('整个目录没有商品了'));
    assert.ok(streamed.every((value) => !value.includes('整个目录没有商品了')));
    if ('limited' in example) {
      assert.equal(modelCalls, 2);
      assert.match(answer, /尚未查完/);
      assert.match(answer, /上限/);
      assert.ok(outputs.at(-1)!.nextOffset !== null);
    } else {
      assert.equal(modelCalls, 3, '找到候选或查完后仍允许模型处理复合请求');
      assert.ok(finalContext.some((entry) => entry.role === 'tool'));
      assert.ok(!answer.includes('轮数上限'));
    }
    if (example.name === '降序查询继续保留排序')
      assert.equal(outputs.at(-1)!.candidates[0].price, 1000);
    if (example.name === '全部空页查完如实收尾')
      assert.equal(outputs.at(-1)!.nextOffset, null);
  });

void test('失败观察、非递进分页和显式page均不能启动继续查询', () => {
  const output = {
    operation: { tool: 'find_replacements', failed: false },
    data: {
      planId: 'plan',
      query: [{ category: 'gpu' }],
      candidates: [],
      offset: 0,
      nextOffset: 10,
      searchScope: 'until_candidate',
      totalPriceRelation: 'cheaper',
    },
  };
  assert.equal(replacementContinuation(output, {})?.offset, 10);
  assert.equal(
    replacementContinuation(
      { ...output, operation: { ...output.operation, failed: true } },
      {},
    ),
    undefined,
  );
  assert.equal(
    replacementContinuation(
      { ...output, data: { ...output.data, nextOffset: 0 } },
      {},
    ),
    undefined,
  );
  assert.equal(
    replacementContinuation(
      { ...output, data: { ...output.data, searchScope: 'page' } },
      {},
    ),
    undefined,
  );
});

void test('完成同一查询仅清理自身续页，保留不同方案与过滤查询', () => {
  const pending: ReplacementContinuation[] = [];
  const output = {
    operation: { tool: 'find_replacements', failed: false },
    data: {
      planId: 'plan',
      query: [{ category: 'gpu' }],
      candidates: [],
      offset: 0,
      nextOffset: 10,
      searchScope: 'until_candidate',
      totalPriceRelation: 'cheaper',
    },
  };
  updateReplacementContinuations(pending, output, {});
  updateReplacementContinuations(
    pending,
    { ...output, data: { ...output.data, planId: 'other' } },
    {},
  );
  updateReplacementContinuations(
    pending,
    {
      ...output,
      data: {
        ...output.data,
        query: [{ category: 'gpu', brand: '另一个品牌' }],
      },
    },
    {},
  );
  assert.equal(pending.length, 3);
  updateReplacementContinuations(
    pending,
    { ...output, data: { ...output.data, candidates: [{}] } },
    {},
  );
  assert.equal(pending.length, 2);
  assert.equal(pending[0].planId, 'other');
  assert.equal(pending[1].items[0].brand, '另一个品牌');
});

void test('指定单页必须明确页位置和用户要求的组合数量，不能默认为10', async () => {
  const f = fixture();
  let reloads = 0;
  f.context.reloadCatalog = async () => {
    reloads++;
    return f.catalog;
  };
  const args = { planId: 'plan-1', category: 'gpu', searchScope: 'page' };
  for (const missingPage of [{}, { offset: 0 }, { limit: 1 }]) {
    const result = await executeRegisteredTool(
      'find_replacements',
      { ...args, ...missingPage },
      f.context,
      f.runtime,
    );
    assert.equal(result.operation.failed, true);
    assert.ok('error' in result);
    assert.match(result.error ?? '', /offset和limit/);
  }
  assert.equal(reloads, 0);
  const exact = await executeRegisteredTool(
    'find_replacements',
    { ...args, offset: 0, limit: 1 },
    f.context,
    f.runtime,
  );
  assert.equal(exact.operation.failed, false);
  assert.ok('data' in exact);
  const data = exact.data as {
    candidates: unknown[];
    rejected: unknown[];
    offset: number;
    nextOffset: number;
    searchScope: string;
  };
  assert.equal(data.searchScope, 'page');
  assert.equal(data.offset, 0);
  assert.equal(data.nextOffset, 1);
  assert.equal(data.candidates.length + data.rejected.length, 1);
  assert.equal(reloads, 1);
  assert.equal(f.saved.length, 0);
});
