import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { exploreParallelPlans } from '../agent/parallel-plans';
import type { Progress } from '../agent/progress';
import { updateProgress } from '../../frontend/progress-state';
import type { RegisteredTool } from '../tools/types';

void test('三分支同时开始，先完成的审核方案立即推送，不等待其他分支', async () => {
  const f = fixture(),
    events: Progress[] = [],
    release: (() => void)[] = [];
  f.context.onProgress = (event) => events.push(event);
  f.context.reloadCatalog = () =>
    new Promise((resolve) => release.push(() => resolve(f.catalog)));
  const pending = exploreParallelPlans(
    f.runtime.result!.plans,
    f.context,
    f.runtime,
    [],
  );
  assert.equal(release.length, 3, '分支不应逐个等待');
  assert.equal(events[0].branches?.length, 3);
  release[1]();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const ready = events.filter((event) => event.status === 'done');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].tier, '方案二');
  assert.equal(ready[0].plan?.deliveryAudit?.status, 'passed');
  assert.equal(f.saved.length, 0, '分支预览不得写入共享任务');
  release[0]();
  release[2]();
  const plans = await pending;
  assert.equal(plans.length, 3);
  assert.equal(events.filter((event) => event.plan).length, 3);
});

void test('商品报价改变导致审核失败时，该分支不发送可查看方案', async () => {
  const f = fixture(),
    events: Progress[] = [];
  const changed = structuredClone(f.catalog);
  changed.parts.find((part) => part.id === 'gpu-cheaper')!.price += 500;
  f.context.reloadCatalog = async () => changed;
  f.context.onProgress = (event) => events.push(event);
  await assert.rejects(
    exploreParallelPlans(f.runtime.result!.plans, f.context, f.runtime, []),
  );
  assert.equal(
    events.some((event) => event.scope === 'plan-0' && event.plan),
    false,
  );
  assert.ok(
    events.some(
      (event) => event.scope === 'plan-0' && event.status === 'error',
    ),
  );
});

void test('配置分支不查知识，最多审核三个不重复组合且原始失败组合不兜底', async (t) => {
  const f = fixture(),
    seed = f.runtime.result!.plans[0]!,
    base = seed.parts.map((part) => part.id),
    combinations = [
      base,
      [...base].reverse(),
      base.map((id) => (id === 'gpu-cheaper' ? 'gpu-a' : id)),
      base.map((id) => (id === 'gpu-cheaper' ? 'gpu-b' : id)),
      base.map((id) => (id === 'gpu-cheaper' ? 'gpu-c' : id)),
    ];
  let round = 0,
    submissions = 0;
  const assembleTool: RegisteredTool = {
      definition: {
        type: 'function',
        function: {
          name: 'assemble_build',
          description: 'test',
          parameters: { type: 'object' },
        },
      },
      async execute() {
        submissions++;
        throw Error('测试候选未通过');
      },
    };
  f.context.modelConfig = {
    key: 'test',
    base: 'https://model.test',
    model: 'test',
  };
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, options?: RequestInit) => {
    const request = JSON.parse(options?.body as string) as {
      tools: { function: { name: string } }[];
    };
    assert.ok(
      request.tools.every((tool) => tool.function.name !== 'retrieve_knowledge'),
    );
    const current = round++,
      name = 'assemble_build',
      args = {
        productIds: combinations[current],
        ...(current === 1 ? { ignored: true } : {}),
      };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${current}`, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    },
  );
  await assert.rejects(
    exploreParallelPlans([seed], f.context, f.runtime, [
      assembleTool,
    ]),
    /没有.*合格组合/,
  );
  assert.equal(submissions, 3);
});

void test('三卡顺序固定，新一轮清除旧预览，迟到事件和最终审核失败不保留旧报价', () => {
  const f = fixture();
  const start: Progress = {
    scope: 'main',
    label: '并行生成',
    status: 'running',
    generationId: 'one',
    branches: [
      { scope: 'plan-0', tier: '低价方案' },
      { scope: 'plan-1', tier: '方案二' },
      { scope: 'plan-2', tier: '高价方案' },
    ],
  };
  let state = updateProgress([], start);
  state = updateProgress(state, {
    scope: 'plan-1',
    label: '已审核',
    status: 'done',
    generationId: 'one',
    plan: f.runtime.result!.plans[1],
  });
  assert.deepEqual(
    state.map((entry) => entry.scope),
    ['main', 'plan-0', 'plan-1', 'plan-2'],
  );
  assert.ok(state[2].plan);
  state = updateProgress(state, { ...start, generationId: 'two' });
  assert.equal(
    state.some((entry) => entry.plan),
    false,
  );
  const before = structuredClone(state);
  state = updateProgress(state, {
    scope: 'plan-2',
    generationId: 'one',
    label: '迟到',
    status: 'done',
    plan: f.runtime.result!.plans[2],
  });
  assert.deepEqual(state, before);
  state = updateProgress(state, {
    scope: 'plan-1',
    generationId: 'two',
    label: '预览',
    status: 'done',
    plan: f.runtime.result!.plans[1],
  });
  state = updateProgress(state, {
    scope: 'main',
    status: 'error',
    label: '最终审核失败',
    invalidatePlans: true,
  });
  assert.equal(
    state.some((entry) => entry.plan),
    false,
  );
  assert.ok(state.every((entry) => entry.status === 'error'));
});
