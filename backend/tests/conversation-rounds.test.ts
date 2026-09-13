import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { availableTools, runConversation } from '../agent/conversation';
import { executeRegisteredTool } from '../tools/registry';
import { retrieveEvidence } from '../rag/evidence';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';

const sse = (payload: string) =>
  new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });

const toolCall = (id: string, name: string, args: unknown) =>
  sse(
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

const text = (content: string) =>
  sse(
    JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    }),
  );

const requestAction = (
  action: string,
  otherTopic: 'support' | 'general' = 'general',
) =>
  toolCall('request-action', 'set_request_action', {
    action,
    sourceMessageId: 'current',
    ...(action === 'other' ? { otherTopic } : {}),
  });

void test('缺少Embedding时解释保留数据库规格，评估降级且不确认方案', async () => {
  const f = fixture();
  f.context.embeddingConfig = {};
  const explained = await executeRegisteredTool(
    'explain_selection',
    { planId: 'plan-0', category: 'cpu' },
    f.context,
    f.runtime,
  );
  assert.equal(explained.operation.failed, false);
  const data = (
    explained as {
      data: {
        parts: {
          specs: unknown;
          knowledgeStatus: string;
          knowledgeNotice: string;
          evidence: unknown[];
        }[];
      };
    }
  ).data;
  assert.equal(data.parts[0].knowledgeStatus, 'unavailable');
  assert.match(data.parts[0].knowledgeNotice, /知识检索不可用/);
  assert.deepEqual(data.parts[0].evidence, []);
  assert.deepEqual(
    data.parts[0].specs,
    f.runtime.result!.plans[0].parts.find((p) => p.category === 'cpu')!.specs,
  );
  const before = structuredClone(f.runtime.result!.selection);
  const evaluated = await executeRegisteredTool(
    'evaluate_plan',
    { planId: 'plan-0' },
    f.context,
    f.runtime,
  );
  assert.equal(evaluated.operation.failed, false);
  assert.equal(f.runtime.result!.evaluation?.knowledgeStatus, 'unavailable');
  assert.deepEqual(f.runtime.result!.selection, before);
});

void test('检索成功保留证据，服务失败明确降级，取消不降级', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const success = await retrieveEvidence(embeddingConfig, 'DDR4 DDR5');
  assert.equal(success.knowledgeStatus, 'available');
  assert.ok(success.evidence.length);
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  const failed = await retrieveEvidence(
    { ...embeddingConfig, model: 'unavailable-test' },
    'CPU',
  );
  assert.equal(failed.knowledgeStatus, 'unavailable');
  assert.deepEqual(failed.evidence, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retrieveEvidence({}, 'CPU', 4, 'sales', undefined, controller.signal),
  );
});

void test('评估追问跨轮编号只评估，不允许模型误确认或修改需求', async (t) => {
  const f = fixture();
  let phase = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string) as {
        tools: { function: { name: string } }[];
      };
      if (request.tools[0]?.function.name === 'set_request_action')
        return toolCall('request-action', 'set_request_action', {
          action: 'evaluate_plan',
          sourceMessageId: 'first',
        });
      if (phase++ === 0) return toolCall('eval', 'evaluate_plan', {});
      if (phase === 2) return text('请指定要评估的方案编号。');
      assert.equal(
        request.tools.some((tool) => tool.function.name === 'select_plan'),
        false,
      );
      if (phase === 3)
        return toolCall('wrong-confirm', 'select_plan', {
          planId: 'plan-0',
          confirm: true,
          sourceMessageId: 'second',
        });
      return text('这里只说明数据库已有规格和预算审核结果。');
    },
  );
  const state = {
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
    currentTaskId: 'task',
    messages: [],
  };
  const first = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    state,
    '方案评估一下',
    'first',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );
  assert.deepEqual(first.messages.at(-1)?.pendingEvaluation?.planIds, [
    'plan-0',
    'plan-1',
    'plan-2',
  ]);
  const second = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    { ...state, messages: first.messages },
    '1',
    'second',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );
  assert.equal(second.result?.evaluation?.planId, 'plan-0');
  assert.match(second.messages.at(-1)!.content, /^知识检索不可用/);
  assert.equal(second.result?.evaluation?.knowledgeStatus, 'unavailable');
  assert.deepEqual(second.result?.selection, state.result?.selection);
  assert.deepEqual(second.draft, state.draft);
  assert.equal(second.messages.at(-1)?.pendingEvaluation, undefined);
  assert.ok(
    f.saved.every((task) => task.result?.selection?.status !== 'confirmed'),
  );
});

void test('需求齐全后只开放完整推荐，避免模型在目录查询中空转', () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '需求已保存' };
  assert.deepEqual(
    availableTools(f.runtime, 1).map((tool) => tool.function.name),
    ['recommend_pc'],
  );
  f.runtime.recommendationAttemptKeys = new Set(['已尝试']);
  assert.deepEqual(
    availableTools(f.runtime, 1).map((tool) => tool.function.name),
    ['finish_exploration'],
  );

  f.runtime.recommendationAttemptKeys = undefined;
  f.runtime.candidateSubmissionKeys = new Set(['候选已提交']);
  assert.equal(
    availableTools(f.runtime, 1).some(
      (tool) => tool.function.name === 'retrieve_knowledge',
    ),
    false,
  );
});

void test('历史需求未保存时按结构化配机动作继续执行，与助手承诺措辞无关', async (t) => {
  const f = fixture();
  let mainCalls = 0;
  const choices: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string) as {
        tool_choice: string;
        tools: { function: { name: string } }[];
        messages: { role: string; content: string }[];
      };
      if (request.messages[0].content.startsWith('你负责')) {
        const { candidate } = JSON.parse(request.messages[1].content) as {
          candidate: { parts: { id: string }[] };
        };
        return toolCall('branch', 'assemble_build', {
          productIds: candidate.parts.map((part) => part.id),
        });
      }
      if (request.tools[0]?.function.name === 'set_request_action') {
        assert.equal(request.tool_choice, 'required');
        return requestAction('recommend');
      }
      choices.push(request.tool_choice);
      switch (mainCalls++) {
        case 0:
          return text('请稍候，配置正在准备中。');
        case 1:
          assert.equal(request.tool_choice, 'required');
          return toolCall('requirements', 'update_requirements', {
            budget: 8000,
            purpose: '游戏',
            mode: 'diy',
          });
        case 2:
          assert.deepEqual(
            request.tools.map((tool) => tool.function.name),
            ['recommend_pc'],
          );
          // 即使供应商忽略 required 返回文本，也继续执行而非让用户再次确认。
          return text('我现在为您生成配置方案。');
        case 3:
          return toolCall('recommend', 'recommend_pc', {});
        default:
          return text('方案已生成，请查看右侧配置与报价。');
      }
    },
  );
  const result = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: {},
      result: null,
      task: { ...f.runtime.task, draft: {}, result: null },
      currentTaskId: 'task',
      messages: [
        {
          id: 'prior',
          role: 'user',
          content: '预算8000元，打游戏',
          taskId: 'task',
        },
        { role: 'assistant', content: '想要DIY还是整机？', taskId: 'task' },
      ],
    },
    'diy',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );
  assert.equal(mainCalls, 5);
  assert.deepEqual(choices, [
    'auto',
    'required',
    'required',
    'required',
    'auto',
  ]);
  assert.equal(result.draft.budget, 8000);
  assert.equal(result.draft.purpose, '游戏');
  assert.equal(result.draft.mode, 'diy');
  assert.ok(result.result?.plans.length);
  assert.ok(
    result.result.plans.every(
      (plan) => plan.deliveryAudit?.status === 'passed',
    ),
  );
  assert.ok(f.saved.some((task) => task.result?.plans.length));
  assert.equal(
    result.messages.at(-1)?.content,
    '方案已生成，请查看右侧配置与报价。',
  );
});

void test('模型反复只承诺生成时有界失败，不把承诺保存成最终答复', async (t) => {
  const f = fixture();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return text('我来为你生成一套主机配置。');
  });
  await assert.rejects(
    runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: {},
        result: null,
        task: { ...f.runtime.task, draft: {}, result: null },
        currentTaskId: 'task',
        messages: [],
      },
      '配一台8000元游戏主机',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    ),
    /尚未执行完配置操作/,
  );
  assert.equal(calls, 3);
  assert.equal(f.saved.length, 0);
});

for (const [question, answer, otherTopic] of [
  [
    '先别生成，我只想知道DIY是什么意思',
    'DIY指自行选择配件来组装电脑。',
    'general',
  ],
  ['现在不要生成配置', '好的，我不会生成配置。', 'general'],
  [
    '电脑黑屏了',
    '请说明开机时是否有风扇转动，以及屏幕上的具体提示。',
    'support',
  ],
] as const) {
  void test(`正常澄清或咨询不被强制配机：${question}`, async (t) => {
    const f = fixture();
    let calls = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (_url: unknown, options: RequestInit) => {
        const request = JSON.parse(options.body as string);
        if (request.tools[0]?.function.name === 'set_request_action')
          return requestAction('other', otherTopic);
        calls++;
        return text(answer);
      },
    );
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: null,
        task: { ...f.runtime.task, result: null },
        currentTaskId: 'task',
        messages: [],
      },
      question,
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    );
    assert.equal(calls, 1);
    if (otherTopic === 'support') {
      assert.match(result.messages.at(-1)?.content ?? '', /屏幕提示原文/);
      assert.notEqual(result.messages.at(-1)?.content, answer);
    } else assert.equal(result.messages.at(-1)?.content, answer);
    assert.equal(f.saved.length, 0);
  });
}

void test('轮次耗尽但没有执行推荐时，不得把模型自称无解当作完成', async (t) => {
  const f = fixture();
  const choices: string[] = [];
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string) as {
        tool_choice: string;
        tools: { function: { name: string } }[];
      };
      choices.push(request.tool_choice);
      const index = calls++;
      if (request.tools[0]?.function.name === 'set_request_action')
        return requestAction('recommend');
      // 模拟真实接口：被强制 none 时只能输出文本。
      if (request.tool_choice === 'none')
        return text(
          '本轮目录内没有找到满足该预算的完整配置，需要调整预算或配色。',
        );
      if (index === 1)
        return toolCall(`call-${index}`, 'update_requirements', {
          budget: 8000,
          purpose: '游戏',
        });
      return toolCall(`call-${index}`, 'search_catalog', { category: 'gpu' });
    },
  );

  await assert.rejects(
    runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: {},
        result: null,
        task: { ...f.runtime.task, draft: {}, result: null },
        currentTaskId: 'task',
        messages: [],
      },
      '配一台8000元游戏主机',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    ),
    /尚未执行完配置操作/,
  );

  assert.equal(calls, 16, '应跑满全部轮次');
  assert.equal(choices[15], 'none', '最后一轮必须放开工具调用');
  assert.equal(
    choices.filter((choice) => choice === 'required').length,
    14,
    '探索未完成时中间轮仍应强制继续',
  );
  assert.ok(f.saved.every((task) => !task.result?.plans.length));
});

void test('推荐已尝试且无法重试时，允许以观察到的阻碍结束探索', async () => {
  const f = fixture();
  // 复现死锁：recommend_pc 失败后没有诊断，注册表又拒绝重新推荐。
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '候选审核失败' };
  f.runtime.recommendationAttemptKeys = new Set(['已尝试']);

  const result = await executeRegisteredTool(
    'finish_exploration',
    { reason: '候选审核失败，需要用户调整预算或配色' },
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, false, JSON.stringify(result));
  assert.equal(f.runtime.exploration?.status, 'blocked');
});

void test('未启动过推荐时，仍不得用局部空查询代替完整目录诊断', async () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '待生成' };

  const result = await executeRegisteredTool(
    'finish_exploration',
    { reason: '显卡查询为空' },
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.match('error' in result ? (result.error ?? '') : '', /recommend_pc/);
});
