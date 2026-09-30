import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExecutionPlan,
  advanceExecutionPlan,
  expectedResultPending,
} from '../agent/execution-plan';
import { availableTools, runConversation } from '../agent/conversation';
import { fixture } from './pc-fixture';
import {
  directTaskInvocation,
  executeRegisteredTool,
  registeredTools,
} from '../tools/registry';
import { validateToolArguments } from '../tools/schema-validation';
import {
  recordCatalogPage,
  assertCatalogPageRequest,
} from '../agent/catalog-pagination';

void test('分页执行前拒绝扩页、偏移跳跃和额外过滤；不同节点不能借用进度', () => {
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        id: 'task1',
        action: 'search_catalog',
        goal: '查全部',
        sourceQuote: '查全部',
        dependsOn: [],
        catalogScope: 'all',
        catalogPageSize: 2,
        invocation: {
          tool: 'search_catalog',
          arguments: { category: 'gpu', limit: 2 },
        },
      },
    ],
    '查全部',
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  assert.throws(
    () => assertCatalogPageRequest(f.runtime, { category: 'gpu', limit: 10 }),
    /最多2/,
  );
  assert.throws(
    () =>
      assertCatalogPageRequest(f.runtime, {
        category: 'gpu',
        limit: 2,
        offset: 2,
      }),
    /连续翻页/,
  );
  assert.throws(
    () =>
      assertCatalogPageRequest(f.runtime, {
        category: 'gpu',
        limit: 2,
        maxPrice: 0,
      }),
    /筛选条件/,
  );
  assert.doesNotThrow(() =>
    assertCatalogPageRequest(f.runtime, {
      category: 'gpu',
      limit: 2,
      kind: 'part',
      sort: 'price_asc',
      offset: 0,
    }),
  );
  f.runtime.executionPlan.nodes.push({
    ...f.runtime.executionPlan.nodes[0],
    id: 'task2',
  });
  recordCatalogPage(
    f.runtime,
    { category: 'gpu', limit: 2 },
    {
      operation: { failed: false },
      data: {
        offset: 0,
        nextOffset: null,
        matchCount: 1,
        matches: [{ id: 'gpu' }],
      },
    },
  );
  f.runtime.executionPlan.activeId = 'task2';
  assert.equal(expectedResultPending(f.runtime), true);
});

void test('全量分页必须连续覆盖，跳页、换过滤条件、重复页和失败不算完成；普通单页不强制翻页', () => {
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        id: 'task1',
        action: 'search_catalog',
        goal: '查全部',
        sourceQuote: '查全部',
        dependsOn: [],
        catalogScope: 'all',
      },
    ],
    '查全部',
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  const page = (
    offset: number,
    ids: string[],
    nextOffset: number | null,
    failed = false,
  ) => ({
    operation: { failed },
    data: {
      offset,
      matches: ids.map((id) => ({ id })),
      matchCount: 4,
      nextOffset,
    },
  });
  const args = { category: 'gpu', limit: 2 };
  recordCatalogPage(f.runtime, args, page(2, ['c', 'd'], null));
  assert.equal(expectedResultPending(f.runtime), true);
  recordCatalogPage(f.runtime, args, page(0, ['a', 'b'], 2));
  recordCatalogPage(f.runtime, args, page(0, ['a', 'b'], 2));
  recordCatalogPage(
    f.runtime,
    { ...args, category: 'cpu' },
    page(2, ['c', 'd'], null),
  );
  recordCatalogPage(f.runtime, args, page(2, ['c', 'd'], null, true));
  assert.equal(expectedResultPending(f.runtime), true);
  recordCatalogPage(f.runtime, args, page(2, ['c', 'd'], null));
  assert.equal(expectedResultPending(f.runtime), false);
  const node = f.runtime.executionPlan.nodes[0];
  node.catalogProgress = undefined;
  recordCatalogPage(f.runtime, args, {
    operation: { failed: false },
    data: { offset: 0, matches: [], matchCount: 0, nextOffset: null },
  });
  assert.equal(expectedResultPending(f.runtime), false);
  node.catalogScope = 'page';
  node.catalogProgress = undefined;
  assert.equal(expectedResultPending(f.runtime), false);
});

for (const mode of ['continue', 'stop', 'page'] as const) {
  void test(`分页调用链：${mode}，首屏不能冒充全量完成`, async (t) => {
    const f = fixture();
    let calls = 0,
      offset = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (calls === 1)
        return response('set_request_action', {
          sourceMessageId: 'current',
          nodes: [
            {
              id: 'task1',
              action: 'search_catalog',
              goal: '分页查显卡',
              sourceQuote: '查询显卡',
              dependsOn: [],
              catalogScope: mode === 'page' ? 'page' : 'all',
              invocation: {
                tool: 'search_catalog',
                arguments: { category: 'gpu', limit: 2, offset: 0 },
              },
            },
          ],
        });
      if (calls === 2 || mode !== 'continue' || offset === 6)
        return response(null, '全部查完了');
      offset += 2;
      return response('search_catalog', { category: 'gpu', limit: 2, offset });
    });
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        task: f.runtime.task,
        currentTaskId: 'task',
        draft: f.runtime.draft,
        result: f.runtime.result,
        messages: [],
      },
      '查询显卡',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    );
    assert.equal(
      result.executionPlan?.nodes[0].status,
      mode === 'stop' ? 'blocked' : 'completed',
    );
    if (mode === 'stop')
      assert.doesNotMatch(result.messages.at(-1)!.content, /全部查完了/);
    if (mode === 'continue')
      assert.equal(
        result.executionPlan?.nodes[0].catalogProgress?.ids.length,
        8,
      );
    if (mode === 'page')
      assert.equal(
        result.facts.filter((fact) => fact.tool === 'search_catalog').length,
        1,
      );
    assert.equal(f.saved.length, 0);
  });
}

void test('漏交计划时拒绝进入业务操作，允许按错误反馈重新提交', async () => {
  const f = fixture();
  f.runtime.requestAction = 'pending';
  const invalid = await executeRegisteredTool(
    'set_request_action',
    { action: 'search_catalog', sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  assert.equal(invalid.operation.failed, true);
  assert.equal(f.runtime.requestAction, 'pending');
  assert.equal(f.saved.length, 0);
  const valid = await executeRegisteredTool(
    'set_request_action',
    { action: 'search_catalog', sourceMessageId: 'current', nodes: [] },
    f.context,
    f.runtime,
  );
  assert.equal(valid.operation.failed, false);
});

const message = '查询显卡价格；预算改为9000元，只记录不要生成';
const nodes = [
  {
    id: 'query',
    action: 'search_catalog',
    goal: '查询显卡价格',
    sourceQuote: '查询显卡价格',
    dependsOn: [],
  },
  {
    id: 'save',
    action: 'save_requirements',
    goal: '记录9000元预算，不生成',
    sourceQuote: '预算改为9000元，只记录不要生成',
    dependsOn: [],
  },
];

void test('DAG拒绝重复ID、缺失依赖、循环、虚构原话和冲突动作', () => {
  assert.throws(
    () => parseExecutionPlan([nodes[0], nodes[0]], message),
    /重复/,
  );
  assert.throws(
    () =>
      parseExecutionPlan([{ ...nodes[0], dependsOn: ['missing'] }], message),
    /不存在/,
  );
  assert.throws(
    () =>
      parseExecutionPlan(
        [
          { ...nodes[0], dependsOn: ['save'] },
          { ...nodes[1], dependsOn: ['query'] },
        ],
        message,
      ),
    /循环/,
  );
  assert.throws(
    () =>
      parseExecutionPlan([{ ...nodes[0], sourceQuote: '确认购买' }], message),
    /原话/,
  );
  assert.throws(
    () =>
      parseExecutionPlan(
        [nodes[1], { ...nodes[0], action: 'recommend' }],
        message,
      ),
    /冲突/,
  );
});

void test('DAG按依赖执行，失败传播但独立节点继续', () => {
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(
    [
      { ...nodes[0], dependsOn: ['save'] },
      nodes[1],
      { ...nodes[0], id: 'independent' },
    ],
    message,
  );
  assert.equal(advanceExecutionPlan(f.runtime, 'current', 'task'), true);
  assert.equal(f.runtime.executionPlan.activeId, 'save');
  f.runtime.executionPlan.nodes[1].status = 'blocked';
  advanceExecutionPlan(f.runtime, 'current', 'task');
  assert.equal(f.runtime.executionPlan.nodes[0].status, 'blocked');
  assert.equal(f.runtime.executionPlan.activeId, 'independent');
});

void test('依赖形态不依赖节点数组顺序，分支合流识别为DAG', () => {
  assert.equal(
    parseExecutionPlan(
      [{ ...nodes[0], dependsOn: ['save'] }, nodes[1]],
      message,
    ).shape,
    'sequential',
  );
  assert.equal(
    parseExecutionPlan([nodes[0], nodes[1]], message).shape,
    'parallel',
  );
  assert.equal(
    parseExecutionPlan(
      [
        nodes[0],
        nodes[1],
        { ...nodes[0], id: 'task3', dependsOn: ['query', 'save'] },
      ],
      message,
    ).shape,
    'dag',
  );
});

function response(name: string | null, args: unknown) {
  const delta = name
    ? {
        tool_calls: [
          {
            index: 0,
            id: crypto.randomUUID(),
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      }
    : { content: String(args) };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
}

const runFixture = (f: ReturnType<typeof fixture>, text = message) =>
  runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      task: f.runtime.task,
      currentTaskId: 'task',
      draft: f.runtime.draft,
      result: f.runtime.result,
      messages: [],
    },
    text,
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );

void test('单任务也进入task1：入口提供完整查询参数时只需入口和收尾两次模型调用', async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, request: RequestInit) => {
      assert.equal(typeof request.body, 'string');
      if (typeof request.body !== 'string') throw Error('请求体必须为字符串');
      const body = JSON.parse(request.body);
      if (calls++ === 0)
        return response('set_request_action', {
          sourceMessageId: 'current',
          nodes: [
            {
              id: 'task1',
              action: 'search_catalog',
              goal: '查询900元以内的显卡',
              sourceQuote: '查询900元以内的显卡',
              dependsOn: [],
              invocation: {
                tool: 'search_catalog',
                arguments: { category: 'gpu', maxPrice: 900 },
              },
            },
          ],
        });
      assert.equal(
        body.messages.filter((m: { role: string }) => m.role === 'tool').length,
        2,
      );
      return response(null, '查询完成，没有符合价格条件的显卡。');
    },
  );
  const output = await runFixture(f, '查询900元以内的显卡');
  assert.equal(calls, 2);
  assert.equal(output.executionPlan?.nodes[0].id, 'task1');
  assert.equal(output.executionPlan?.shape, 'single');
  assert.equal(output.executionPlan?.nodes[0].outcome, 'succeeded');
  assert.deepEqual(
    output.facts.find((fact) => fact.tool === 'search_catalog')?.arguments,
    { category: 'gpu', maxPrice: 900 },
  );
  assert.equal(f.saved.length, 0);
});

void test('注册表元数据完整：参数缺失或工具不可用时不走直执行，读任务不能计划写工具', () => {
  for (const tool of registeredTools)
    assert.ok(tool.metadata && tool.definition.function.parameters);
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        ...nodes[0],
        action: 'select_plan',
        invocation: { tool: 'select_plan', arguments: { planId: 'plan-1' } },
        expected: { tool: 'select_plan', arguments: { planId: 'plan-1' } },
      },
    ],
    message,
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  assert.equal(
    directTaskInvocation(f.runtime, availableTools(f.runtime)),
    undefined,
  );
  f.runtime.executionPlan.nodes[0].invocation!.arguments.sourceMessageId =
    'current';
  assert.ok(directTaskInvocation(f.runtime, availableTools(f.runtime)));
  assert.equal(directTaskInvocation(f.runtime, []), undefined);
  assert.throws(
    () =>
      parseExecutionPlan(
        [{ ...nodes[0], invocation: { tool: 'replace_parts', arguments: {} } }],
        message,
      ),
    /权限/,
  );
  const schema = registeredTools.find(
    (tool) => tool.definition.function.name === 'search_catalog',
  )!.definition.function.parameters;
  for (const args of [
    { limit: 0 },
    { limit: 1.2 },
    { kind: 'unknown' },
    { maxPrice: '900' },
    { unexpected: true },
  ])
    assert.throws(() => validateToolArguments(args, schema));
});

void test('成功调用不等于完成目标：保存错误预算后必须修正为计划中的预算', async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    switch (calls++) {
      case 0:
        return response('set_request_action', {
          action: 'save_requirements',
          sourceMessageId: 'current',
          nodes: [
            {
              ...nodes[1],
              id: 'task1',
              expected: {
                tool: 'update_requirements',
                arguments: { budget: 9000 },
              },
            },
          ],
        });
      case 1:
        return response('update_requirements', { budget: 8500 });
      case 2:
        return response(null, '错误完成声明');
      case 3:
        return response('update_requirements', { budget: 9000 });
      default:
        return response(null, '已记录9000元预算。');
    }
  });
  const output = await runFixture(f);
  assert.equal(output.draft.budget, 9000);
  assert.equal(output.executionPlan?.nodes[0].status, 'completed');
  assert.doesNotMatch(output.messages.at(-1)!.content, /错误完成声明/);
  assert.equal(calls, 5);
});

void test('结果校验核对当前状态，不能只借用曾成功的参数', async () => {
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        ...nodes[1],
        expected: { tool: 'update_requirements', arguments: { budget: 9000 } },
      },
    ],
    message,
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  await executeRegisteredTool(
    'update_requirements',
    { budget: 9000 },
    f.context,
    f.runtime,
  );
  assert.equal(expectedResultPending(f.runtime), false);
  f.runtime.draft.budget = 8000;
  assert.equal(expectedResultPending(f.runtime), true);
});

void test('需求结果校验沿用空字符串清除语义，不把正确删除误判为失败', async () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.draft.brandPreferences = { cpu: '测试品牌' };
  const args = { brandPreferences: { cpu: '' } };
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        ...nodes[1],
        expected: { tool: 'update_requirements', arguments: args },
      },
    ],
    message,
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  const output = await executeRegisteredTool(
    'update_requirements',
    args,
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  assert.equal(expectedResultPending(f.runtime), false);
  assert.equal(f.runtime.draft.brandPreferences?.cpu, undefined);
});

void test('受限重规划保留预期目标、拒绝循环与已完成节点，且不重置全轮额度', async () => {
  const f = fixture();
  f.context.messages.find((m) => m.id === 'current')!.content = message;
  f.runtime.executionPlan = parseExecutionPlan(
    [
      {
        ...nodes[0],
        expected: { tool: 'search_catalog', arguments: { category: 'gpu' } },
      },
      nodes[1],
    ],
    message,
  );
  advanceExecutionPlan(f.runtime, 'current', 'task');
  await executeRegisteredTool(
    'search_catalog',
    { unexpected: true },
    f.context,
    f.runtime,
  );
  f.runtime.recommendationAttemptKeys = new Set(['existing']);
  for (const edit of [
    { id: 'query', dependsOn: ['query'] },
    {
      id: 'query',
      dependsOn: [],
      invocation: { tool: 'search_catalog', arguments: { category: 'cpu' } },
    },
    {
      id: 'query',
      dependsOn: [],
      invocation: { tool: 'replace_parts', arguments: {} },
    },
  ]) {
    const bad = await executeRegisteredTool(
      'revise_execution_plan',
      { reason: '测试非法修订', revisions: [edit] },
      f.context,
      f.runtime,
    );
    assert.equal(bad.operation.failed, true);
    assert.equal(f.runtime.executionPlan.replans, undefined);
  }
  f.runtime.executionPlan.nodes[1].status = 'completed';
  const completed = await executeRegisteredTool(
    'revise_execution_plan',
    { reason: '不能重复执行', revisions: [{ id: 'save', dependsOn: [] }] },
    f.context,
    f.runtime,
  );
  assert.equal(completed.operation.failed, true);
  const revised = await executeRegisteredTool(
    'revise_execution_plan',
    {
      reason: '改用完整的显卡查询参数',
      revisions: [
        {
          id: 'query',
          dependsOn: [],
          invocation: {
            tool: 'search_catalog',
            arguments: { category: 'gpu' },
          },
        },
      ],
    },
    f.context,
    f.runtime,
  );
  assert.equal(revised.operation.failed, false);
  assert.equal(f.runtime.executionPlan.replans, 1);
  assert.equal(f.runtime.executionPlan.nodes[1].status, 'completed');
  assert.deepEqual([...f.runtime.recommendationAttemptKeys], ['existing']);
  await executeRegisteredTool(
    'search_catalog',
    { unexpected: true },
    f.context,
    f.runtime,
  );
  const repeated = await executeRegisteredTool(
    'revise_execution_plan',
    { reason: '再次重规划', revisions: [{ id: 'query', dependsOn: [] }] },
    f.context,
    f.runtime,
  );
  assert.equal(repeated.operation.failed, true);
});

void test('没有前置配置时不强行选择方案，明确返回NO_SUITABLE_TOOL', async (t) => {
  const f = fixture();
  f.runtime.result = null;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    calls++ === 0
      ? response('set_request_action', {
          action: 'select_plan',
          sourceMessageId: 'current',
          nodes: [],
        })
      : response(null, '已经选择了。'),
  );
  const output = await runFixture(f, '选定均衡方案');
  assert.equal(output.executionPlan?.nodes[0].errorCode, 'NO_SUITABLE_TOOL');
  assert.doesNotMatch(output.messages.at(-1)!.content, /已经选择了/);
  assert.equal(f.saved.length, 0);
});

void test('相同工具的前节点成功不算后节点完成；只承诺时仍要求执行', async (t) => {
  const f = fixture();
  let phase = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      if (typeof options.body !== 'string') throw Error('请求体必须为字符串');
      const body = JSON.parse(options.body);
      switch (phase++) {
        case 0:
          return response('set_request_action', {
            action: 'search_catalog',
            sourceMessageId: 'current',
            nodes: [
              nodes[0],
              { ...nodes[0], id: 'second', dependsOn: ['query'] },
            ],
          });
        case 1:
          return response('search_catalog', { category: 'gpu' });
        case 2:
          return response(null, '第一项已查询。');
        case 3:
          return response(null, '第二项也完成了。');
        case 4:
          assert.equal(body.tool_choice, 'required');
          return response('search_catalog', {
            category: 'gpu',
            maxPrice: 1000,
          });
        default:
          return response(null, '第二项已查询。');
      }
    },
  );
  const output = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      task: f.runtime.task,
      currentTaskId: 'task',
      draft: f.runtime.draft,
      result: f.runtime.result,
      messages: [],
    },
    message,
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );
  assert.equal(
    output.facts.filter((f) => f.tool === 'search_catalog' && !f.failed).length,
    2,
  );
  assert.ok(output.executionPlan?.nodes.every((n) => n.status === 'completed'));
  assert.doesNotMatch(output.messages.at(-1)!.content, /第二项也完成了/);
});

for (const failSave of [false, true]) {
  void test(`真实调用链模拟：查询与预算更新分别核验，更新失败=${failSave}`, async (t) => {
    const f = fixture();
    let phase = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options: RequestInit) => {
        assert.equal(typeof options.body, 'string');
        if (typeof options.body !== 'string') throw Error('请求体必须为字符串');
        const body = JSON.parse(options.body);
        if (body.tool_choice === 'none') {
          assert.equal(failSave, false, '失败节点不能交给自由文本重新宣称成功');
          assert.equal(body.tools?.length ?? 0, 0);
          return response(
            null,
            '已查询显卡价格，当前预算9000元，本轮未生成配置。',
          );
        }
        switch (phase++) {
          case 0:
            return response('set_request_action', {
              action: 'search_catalog',
              sourceMessageId: 'current',
              nodes,
            });
          case 1:
            assert.ok(
              !body.tools.some(
                (x: { function: { name: string } }) =>
                  x.function.name === 'update_requirements',
              ),
            );
            return response('search_catalog', { category: 'gpu' });
          case 2:
            return response(
              null,
              failSave ? '预算更新假成功声明' : '已查询显卡价格。',
            );
          case 3:
            assert.ok(
              body.tools.some(
                (x: { function: { name: string } }) =>
                  x.function.name === 'update_requirements',
              ),
            );
            assert.ok(
              !body.tools.some(
                (x: { function: { name: string } }) =>
                  x.function.name === 'recommend_pc',
              ),
            );
            return response('update_requirements', {
              budget: failSave ? -1 : 9000,
            });
          default:
            return response(null, '我已经把预算改为9000元。');
        }
      },
    );
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        task: f.runtime.task,
        currentTaskId: 'task',
        draft: f.runtime.draft,
        result: f.runtime.result,
        messages: [],
      },
      message,
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    );
    assert.equal(result.draft.budget, failSave ? 8000 : 9000);
    assert.equal(result.executionPlan?.nodes[0].status, 'completed');
    assert.equal(
      result.executionPlan?.nodes[1].status,
      failSave ? 'blocked' : 'completed',
    );
    assert.ok(!result.facts.some((x) => x.tool === 'recommend_pc'));
    if (failSave)
      assert.doesNotMatch(
        result.messages.at(-1)!.content,
        /我已经把预算改为|预算更新假成功声明/,
      );
    else assert.match(result.messages.at(-1)!.content, /当前预算9000/);
  });
}
