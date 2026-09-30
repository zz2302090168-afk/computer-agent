import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { canCompleteDirectQuery } from '../agent/query-completion';
import {
  advanceExecutionPlan,
  parseExecutionPlan,
} from '../agent/execution-plan';
import { availableTools, runConversation } from '../agent/conversation';
import {
  consumePreparedRead,
  prepareParallelReads,
  type PreparedRead,
} from '../agent/parallel-reads';

const message = '查询显卡和CPU，再比较';
const node = (id: string, category: string, dependsOn: string[] = []) => ({
  id,
  action: 'search_catalog',
  goal: `查询${category}`,
  sourceQuote: '查询显卡和CPU',
  dependsOn,
  invocation: { tool: 'search_catalog', arguments: { category } },
});
const setup = (nodes = [node('task1', 'gpu'), node('task2', 'cpu')]) => {
  const f = fixture();
  f.runtime.executionPlan = parseExecutionPlan(nodes, message);
  advanceExecutionPlan(f.runtime, 'current', 'task');
  return f;
};

void test('直查询完成判定：必须成功、目标匹配且没有下一页，写任务不能走捷径', async () => {
  const f = setup();
  const prepared = new Map<string, PreparedRead>();
  await prepareParallelReads(f.runtime, f.context, availableTools, prepared);
  const output = consumePreparedRead(
    prepared.get('task1')!,
    f.runtime,
    f.context,
  );
  f.runtime.executionPlan!.nodes[0].directAttempted = true;
  assert.equal(canCompleteDirectQuery(f.runtime, output), true);
  assert.equal(
    canCompleteDirectQuery(f.runtime, { ...output, data: { nextOffset: 10 } }),
    false,
  );
  assert.equal(
    canCompleteDirectQuery(f.runtime, {
      ...output,
      operation: { failed: true },
    }),
    false,
  );
  f.runtime.executionPlan!.nodes[0].expected!.arguments.category = 'memory';
  assert.equal(canCompleteDirectQuery(f.runtime, output), false);
  f.runtime.executionPlan!.nodes[0].expected!.arguments.category = 'gpu';
  f.runtime.executionPlan!.nodes[1].action = 'save_requirements';
  assert.equal(canCompleteDirectQuery(f.runtime, output), false);
});

void test('纯查询多意图只调用入口与汇总模型，不逐节点重复生成小结', async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, request: RequestInit) => {
      assert.ok(typeof request.body === 'string');
      const body = JSON.parse(request.body);
      const first = calls++ === 0;
      if (!first) {
        assert.equal(body.tool_choice, 'none');
        assert.equal(
          body.messages.filter((m: { role: string }) => m.role === 'tool')
            .length,
          3,
        );
      }
      const delta = first
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'entry',
                type: 'function',
                function: {
                  name: 'set_request_action',
                  arguments: JSON.stringify({
                    sourceMessageId: 'current',
                    nodes: [node('task1', 'gpu'), node('task2', 'cpu')],
                  }),
                },
              },
            ],
          }
        : { content: '已查询两个类别，未修改需求或配置。' };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
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
  assert.equal(calls, 2);
  assert.equal(output.modelCalls, 2);
  assert.ok(
    output.executionPlan!.nodes.every((entry) => entry.status === 'completed'),
  );
  assert.equal(f.saved.length, 0);
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

void test('先判断再执行：两项只读查询确实同时启动，乱序完成仍按节点隔离结果', async () => {
  const f = setup();
  const first = gate(),
    second = gate();
  let started = 0;
  f.context.reloadCatalog = async () => {
    const index = started++;
    await (index === 0 ? first.promise : second.promise);
    return f.catalog;
  };
  const prepared = new Map<string, PreparedRead>();
  const running = prepareParallelReads(
    f.runtime,
    f.context,
    availableTools,
    prepared,
  );
  assert.equal(started, 2, '释放任何一个查询之前，两个查询必须都已经启动');
  assert.equal(f.runtime.executionPlan!.parallelDecision?.mode, 'parallel');
  assert.equal(f.runtime.facts.length, 0, '分支不能直接改主运行态');
  second.resolve();
  first.resolve();
  await running;
  assert.equal(prepared.size, 2);
  for (const [id, category] of [
    ['task1', 'gpu'],
    ['task2', 'cpu'],
  ]) {
    const result = prepared.get(id)!;
    assert.equal(result.output.operation.failed, false);
    assert.equal(result.runtime.facts[0].nodeId, id);
    assert.deepEqual(result.runtime.facts[0].arguments, { category });
  }
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
  });
  consumePreparedRead(prepared.get('task1')!, f.runtime, f.context);
  assert.equal(f.runtime.facts.length, 1);
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result, task: f.runtime.task },
    before,
  );
  assert.equal(f.saved.length, 0);
});

void test('依赖未就绪、写入冲突或参数不合法时，判为串行且不预执行工具', async () => {
  const cases: unknown[][] = [
    [node('task1', 'gpu'), node('task2', 'cpu', ['task1'])],
    [
      node('task1', 'gpu'),
      {
        ...node('task2', 'cpu'),
        action: 'save_requirements',
        invocation: {
          tool: 'update_requirements',
          arguments: { budget: 9000 },
        },
      },
    ],
    [node('task1', 'gpu'), node('task2', 'invalid')],
    [node('task1', 'gpu'), { ...node('task2', 'cpu'), invocation: undefined }],
  ];
  for (const nodes of cases) {
    const f = fixture();
    f.runtime.executionPlan = parseExecutionPlan(nodes, message);
    advanceExecutionPlan(f.runtime, 'current', 'task');
    let started = 0;
    f.context.reloadCatalog = async () => {
      started++;
      return f.catalog;
    };
    await prepareParallelReads(f.runtime, f.context, availableTools, new Map());
    assert.equal(started, 0);
    assert.equal(f.runtime.executionPlan.parallelDecision?.mode, 'serial');
    assert.equal(f.saved.length, 0);
  }
});

void test('并行单支失败不抹掉另一支结果；取消则不交回任何迟到结果', async () => {
  const f = setup();
  let calls = 0;
  f.context.reloadCatalog = async () => {
    if (calls++ === 0) throw Error('目录读取失败');
    return f.catalog;
  };
  const prepared = new Map<string, PreparedRead>();
  await prepareParallelReads(f.runtime, f.context, availableTools, prepared);
  assert.equal(prepared.get('task1')!.output.operation.failed, true);
  assert.equal(prepared.get('task2')!.output.operation.failed, false);

  const cancelled = setup(),
    barrier = gate(),
    controller = new AbortController();
  cancelled.context.signal = controller.signal;
  cancelled.context.reloadCatalog = async () => {
    await barrier.promise;
    return cancelled.catalog;
  };
  const late = new Map<string, PreparedRead>();
  const running = prepareParallelReads(
    cancelled.runtime,
    cancelled.context,
    availableTools,
    late,
  );
  controller.abort();
  barrier.resolve();
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(late.size, 0);
  assert.equal(cancelled.runtime.facts.length, 0);
  assert.equal(cancelled.saved.length, 0);
});

void test('并行批次最多四项，重规划后旧结果失效', async () => {
  const f = setup(
    Array.from({ length: 6 }, (_, i) => node(`task${i + 1}`, 'gpu')),
  );
  let calls = 0;
  f.context.reloadCatalog = async () => {
    calls++;
    return f.catalog;
  };
  const prepared = new Map<string, PreparedRead>();
  await prepareParallelReads(f.runtime, f.context, availableTools, prepared);
  assert.equal(calls, 4);
  assert.equal(prepared.size, 4);
  f.runtime.executionPlan = parseExecutionPlan([node('task1', 'cpu')], message);
  advanceExecutionPlan(f.runtime, 'current', 'task');
  await prepareParallelReads(f.runtime, f.context, availableTools, prepared);
  assert.equal(prepared.size, 0);
});

void test('完整调用链：两个查询并发且不重复执行，依赖它们的比较在结果汇合后进行', async (t) => {
  const f = fixture();
  let starts = 0,
    calls = 0;
  const barrier = gate();
  const reload = async () => {
    starts++;
    if (starts === 2) barrier.resolve();
    await barrier.promise;
    return f.catalog;
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, request: RequestInit) => {
      assert.ok(typeof request.body === 'string');
      const body = JSON.parse(request.body);
      let delta: unknown;
      if (calls++ === 0)
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'plan',
              type: 'function',
              function: {
                name: 'set_request_action',
                arguments: JSON.stringify({
                  sourceMessageId: 'current',
                  nodes: [
                    node('task1', 'gpu'),
                    node('task2', 'cpu'),
                    {
                      id: 'task3',
                      action: 'other',
                      otherTopic: 'general',
                      goal: '比较查询结果',
                      sourceQuote: '再比较',
                      dependsOn: ['task1', 'task2'],
                    },
                  ],
                }),
              },
            },
          ],
        };
      else {
        assert.equal(starts, 2);
        if (body.messages[0].content.includes('当前仅执行节点task3')) {
          assert.ok(body.messages[0].content.includes('"id":"task1"'));
          const facts = body.messages
            .filter((m: { role: string }) => m.role === 'tool')
            .map((m: { content: string }) => JSON.parse(m.content));
          assert.equal(
            facts.filter(
              (output: { operation?: { tool: string; failed: boolean } }) =>
                output.operation?.tool === 'search_catalog' &&
                !output.operation.failed,
            ).length,
            2,
          );
        }
        delta = { content: '已根据两项查询结果完成说明。' };
      }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
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
    reload,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    AbortSignal.timeout(3000),
  );
  assert.equal(starts, 2);
  assert.ok(output.executionPlan!.nodes.every((n) => n.status === 'completed'));
  assert.deepEqual(
    output.facts
      .filter((fact) => fact.tool === 'search_catalog')
      .map((fact) => fact.nodeId),
    ['task1', 'task2'],
  );
  assert.equal(f.saved.length, 0);
});
