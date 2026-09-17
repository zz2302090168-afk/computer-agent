import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableTools,
  runConversation,
  type ChatState,
} from '../agent/conversation';
import type { ModelMessage } from '../agent/chat-model';
import { executeRegisteredTool } from '../tools/registry';
import { searchCatalogTool } from '../tools/catalog/search';
import { fixture } from './pc-fixture';

function consultationFixture() {
  const f = fixture();
  const partIds = f.catalog.parts
    .filter((part) => part.id === part.category)
    .map((part) => part.id);
  f.catalog.prebuilts = Array.from({ length: 12 }, (_, index) => ({
    id: `pc-${index}`,
    name: '同名测试组装整机',
    brand: '测试品牌',
    price: 6000 + index * 100,
    color: '黑色',
    partIds,
    demo: true,
  }));
  return f;
}

function modelResponse(message: Omit<ModelMessage, 'role'>) {
  return new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            content: message.content,
            ...(message.tool_calls
              ? {
                  tool_calls: message.tool_calls.map((call, index) => ({
                    ...call,
                    index,
                  })),
                }
              : {}),
          },
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function call(id: string, name: string, args: unknown) {
  return {
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

void test('咨询附件阻止模型把本轮误判为选定，纠正动作后仍只读且查询精确商品', async (t) => {
  const f = consultationFixture();
  const state: ChatState = {
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
    currentTaskId: 'task',
    messages: [],
  };
  const before = structuredClone({ draft: state.draft, result: state.result });
  let round = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(options!.body as string) as {
        messages: ModelMessage[];
        tools: { function: { name: string } }[];
      };
      if (round++ === 0)
        return modelResponse({
          content: null,
          tool_calls: [
            call('wrong-action', 'set_request_action', {
              action: 'select_plan',
              sourceMessageId: 'current',
            }),
            call('wrong-selection', 'select_plan', {
              planId: 'plan-0',
              sourceMessageId: 'current',
            }),
          ],
        });
      if (round === 2) {
        assert.deepEqual(
          request.tools.map((tool) => tool.function.name),
          ['set_request_action'],
        );
        assert.match(
          request.messages.find(
            (entry) => entry.tool_call_id === 'wrong-action',
          )!.content!,
          /只能声明 search_catalog/,
        );
        assert.match(
          request.messages.find(
            (entry) => entry.tool_call_id === 'wrong-selection',
          )!.content!,
          /当前状态不可调用工具/,
        );
        return modelResponse({
          content: null,
          tool_calls: [
            call('correct-action', 'set_request_action', {
              action: 'search_catalog',
              sourceMessageId: 'current',
            }),
          ],
        });
      }
      if (round === 3)
        return modelResponse({
          content: null,
          tool_calls: [
            call('target', 'search_catalog', {
              kind: 'prebuilt',
              prebuiltId: 'pc-1',
            }),
          ],
        });
      return modelResponse({
        content: '这台整机的目录价为6100元，仅介绍商品资料。',
      });
    },
  );
  const next = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    state,
    '介绍一下这台',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    undefined,
    'pc-1',
  );
  assert.deepEqual({ draft: next.draft, result: next.result }, before);
  assert.equal(f.saved.length, 0);
  assert.equal(
    next.facts.find((fact) => fact.tool === 'set_request_action')!.failed,
    true,
  );
  f.runtime.consultPrebuiltId = 'pc-1';
  f.runtime.requestAction = 'select_plan';
  assert.deepEqual(
    new Set(availableTools(f.runtime, 1).map((tool) => tool.function.name)),
    new Set(['search_catalog', 'retrieve_knowledge']),
  );
  const denied = await executeRegisteredTool(
    'select_plan',
    { planId: 'plan-0', sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  assert.equal(denied.operation.failed, true);
  assert.equal(f.saved.length, 0);
});

void test('咨询首查询不能用另一台同名整机或配件冒充，未查目标不能结束，纠正后可只读比较', async (t) => {
  for (const wrongQuery of [
    { kind: 'prebuilt', prebuiltId: 'pc-0' },
    { kind: 'part', category: 'gpu' },
  ]) {
    const f = consultationFixture();
    const state: ChatState = {
      draft: f.runtime.draft,
      result: f.runtime.result,
      task: f.runtime.task,
      currentTaskId: 'task',
      messages: [],
    };
    const before = structuredClone({
      draft: state.draft,
      result: state.result,
    });
    let round = 0,
      catalogReads = 0;
    const reload = async () => {
      catalogReads++;
      return f.catalog;
    };
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options?: RequestInit) => {
        const request = JSON.parse(options!.body as string) as {
          messages: ModelMessage[];
          tool_choice: string;
        };
        if (round++ === 0)
          return modelResponse({
            content: null,
            tool_calls: [
              call('action', 'set_request_action', {
                action: 'search_catalog',
                sourceMessageId: 'current',
              }),
            ],
          });
        if (round === 2)
          return modelResponse({
            content: null,
            tool_calls: [call('wrong-query', 'search_catalog', wrongQuery)],
          });
        if (round === 3) {
          assert.match(
            request.messages.find(
              (entry) => entry.tool_call_id === 'wrong-query',
            )!.content!,
            /请先精确查询.*prebuiltId=pc-1/,
          );
          assert.equal(catalogReads, 0);
          assert.equal(request.tool_choice, 'required');
          return modelResponse({ content: '已经查好了，可以结束。' });
        }
        if (round === 4)
          return modelResponse({
            content: null,
            tool_calls: [
              call('target-query', 'search_catalog', {
                kind: 'prebuilt',
                prebuiltId: 'pc-1',
              }),
            ],
          });
        if (round === 5) {
          const target = JSON.parse(
            request.messages.find(
              (entry) => entry.tool_call_id === 'target-query',
            )!.content!,
          ).data;
          assert.equal(target.matches.length, 1);
          assert.equal(target.matches[0].id, 'pc-1');
          return modelResponse({
            content: null,
            tool_calls: [
              call('compare-query', 'search_catalog', {
                kind: 'prebuilt',
                prebuiltId: 'pc-2',
              }),
            ],
          });
        }
        const comparison = JSON.parse(
          request.messages.find(
            (entry) => entry.tool_call_id === 'compare-query',
          )!.content!,
        );
        assert.equal(comparison.operation.failed, false);
        return modelResponse({
          content: '已读取指定整机及另一台用于比较的整机，未改动当前方案。',
        });
      },
    );
    const next = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      state,
      '介绍一下这台',
      'current',
      f.catalog,
      reload,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
      undefined,
      undefined,
      undefined,
      'pc-1',
    );
    assert.equal(round, 6);
    assert.equal(catalogReads, 2);
    assert.deepEqual({ draft: next.draft, result: next.result }, before);
    assert.equal(f.saved.length, 0);
    // 本轮只交付工具证据正文，不再采用模型自写的总结。
    assert.match(next.messages.at(-1)!.content, /整机目录价¥6100/);
    assert.match(next.messages.at(-1)!.content, /整机目录价¥6200/);
    assert.match(next.messages.at(-1)!.content, /未选定或确认/);
  }
});

void test('整机精确查询重读当前商品，区分同名商品且保留完整构成，不修改任务', async () => {
  const f = consultationFixture();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  const fresh = structuredClone(f.catalog);
  fresh.prebuilts[1]!.price = 6123;
  f.context.reloadCatalog = async () => fresh;
  const result = (await searchCatalogTool.execute(
    { kind: 'prebuilt', prebuiltId: 'pc-1' },
    f.context,
    f.runtime,
  )) as {
    matches: { id: string; price: number; parts: { id: string }[] }[];
    matchCount: number;
    nextOffset: number | null;
    evidenceScope: string;
  };
  assert.equal(result.matchCount, 1);
  assert.equal(result.nextOffset, null);
  assert.equal(result.matches[0]!.id, 'pc-1');
  assert.equal(result.matches[0]!.price, 6123);
  assert.equal(result.matches[0]!.parts.length, 8);
  assert.match(result.evidenceScope, /未选定或确认/);
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
  assert.equal(f.saved.length, 0);
  await assert.rejects(
    searchCatalogTool.execute(
      { kind: 'part', prebuiltId: 'pc-1' },
      f.context,
      f.runtime,
    ),
    /仅可用于整机查询/,
  );
  await assert.rejects(
    searchCatalogTool.execute(
      { kind: 'prebuilt', prebuiltId: 'removed' },
      f.context,
      f.runtime,
    ),
    /已不在当前商品目录/,
  );
});

void test('整机普通查询保留分页，不把当前十条结果当成全部商品', async () => {
  const f = consultationFixture();
  const first = (await searchCatalogTool.execute(
    { kind: 'prebuilt' },
    f.context,
    f.runtime,
  )) as {
    matchCount: number;
    nextOffset: number | null;
    matches: { id: string }[];
  };
  assert.equal(first.matchCount, 12);
  assert.equal(first.matches.length, 10);
  assert.equal(first.nextOffset, 10);
  const next = (await searchCatalogTool.execute(
    { kind: 'prebuilt', offset: first.nextOffset },
    f.context,
    f.runtime,
  )) as typeof first;
  assert.equal(next.matches.length, 2);
  assert.equal(next.nextOffset, null);
});

void test('无预算用途也能咨询整机，模型收到当前和历史精确 ID，聊天正文保持自然语言', async (t) => {
  const f = consultationFixture();
  const state: ChatState = {
    draft: {},
    result: null,
    task: { ...f.runtime.task, draft: {}, result: null },
    currentTaskId: 'task',
    messages: [
      {
        id: 'previous',
        role: 'user',
        content: '之前看过这台',
        consultPrebuiltId: 'pc-0',
        taskId: 'task',
      },
    ],
  };
  let round = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(options!.body as string) as {
        messages: ModelMessage[];
        tools: { function: { name: string } }[];
        tool_choice: string;
      };
      assert.match(
        request.messages.find(
          (entry) =>
            entry.role === 'user' && entry.content?.includes('previous'),
        )!.content!,
        /"prebuiltId":"pc-0"/,
      );
      assert.match(
        request.messages.find(
          (entry) =>
            entry.role === 'user' && entry.content?.includes('current'),
        )!.content!,
        /"prebuiltId":"pc-1"/,
      );
      assert.match(
        request.messages.findLast((entry) => entry.role === 'user')!.content!,
        /不代表选定、替换或购买确认/,
      );
      if (round++ === 0)
        return modelResponse({
          content: null,
          tool_calls: [
            call('action', 'set_request_action', {
              action: 'search_catalog',
              sourceMessageId: 'current',
            }),
          ],
        });
      assert.deepEqual(
        new Set(request.tools.map((entry) => entry.function.name)),
        new Set(['search_catalog', 'retrieve_knowledge']),
      );
      if (round === 2) {
        assert.equal(request.tool_choice, 'required');
        return modelResponse({
          content: null,
          tool_calls: [
            call('lookup', 'search_catalog', {
              kind: 'prebuilt',
              prebuiltId: 'pc-1',
            }),
          ],
        });
      }
      return modelResponse({
        content:
          '这台目录价为6100元。[查看全部组装整机](/catalog?kind=prebuilt)',
      });
    },
  );
  const next = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    state,
    '介绍一下这台组装整机',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    undefined,
    'pc-1',
  );
  assert.deepEqual(next.messages.at(-2), {
    id: 'current',
    role: 'user',
    content: '介绍一下这台组装整机',
    taskId: 'task',
    consultPrebuiltId: 'pc-1',
  });
  assert.equal(next.result, null);
  assert.deepEqual(next.draft, {});
  assert.equal(f.saved.length, 0);
  assert.deepEqual(
    next.facts.map((fact) => fact.tool),
    ['set_request_action', 'search_catalog'],
  );
});

void test('咨询附件商品已失效时在模型调用前明确失败，不保存任务或替换成其他商品', async (t) => {
  const f = consultationFixture();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw Error('不应调用模型');
  });
  await assert.rejects(
    runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      '介绍一下这台',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
      undefined,
      undefined,
      undefined,
      'removed',
    ),
    /咨询的组装整机已不在当前商品目录/,
  );
  assert.equal(requests, 0);
  assert.equal(f.saved.length, 0);
});

void test('目录咨询中模型同批查询后尝试选定或换件被阻断，现有方案保持不变', async (t) => {
  const f = consultationFixture();
  const state: ChatState = {
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
    currentTaskId: 'task',
    messages: [],
  };
  const before = structuredClone({ draft: state.draft, result: state.result });
  let round = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const request = JSON.parse(options!.body as string) as {
        messages: ModelMessage[];
      };
      if (round++ === 0)
        return modelResponse({
          content: null,
          tool_calls: [
            call('action', 'set_request_action', {
              action: 'search_catalog',
              sourceMessageId: 'current',
            }),
          ],
        });
      if (round === 2)
        return modelResponse({
          content: null,
          tool_calls: [
            call('lookup', 'search_catalog', {
              kind: 'prebuilt',
              prebuiltId: 'pc-1',
            }),
            call('select', 'select_plan', {
              planId: 'plan-0',
              sourceMessageId: 'current',
            }),
            call('replace', 'replace_parts', {
              planId: 'plan-0',
              sourceMessageId: 'current',
              replacements: [{ oldId: 'gpu-cheaper', newId: 'gpu' }],
            }),
          ],
        });
      for (const id of ['select', 'replace'])
        assert.match(
          request.messages.find((entry) => entry.tool_call_id === id)!.content!,
          /当前状态不可调用工具/,
        );
      return modelResponse({ content: '这里只介绍该商品，当前配置保持不变。' });
    },
  );
  const next = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    state,
    '介绍一下这台整机',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    undefined,
    'pc-1',
  );
  assert.deepEqual({ draft: next.draft, result: next.result }, before);
  assert.equal(f.saved.length, 0);
  f.runtime.requestAction = 'search_catalog';
  for (const name of ['select_plan', 'replace_parts', 'select_prebuilt']) {
    const result = await executeRegisteredTool(name, {}, f.context, f.runtime);
    assert.equal(result.operation.failed, true);
    assert.match(
      'error' in result ? (result.error ?? '') : '',
      /当前用户动作不允许此操作/,
    );
  }
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
});
