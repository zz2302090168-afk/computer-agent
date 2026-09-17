import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { availableTools, runConversation } from '../agent/conversation';
import type { ModelMessage, ToolDefinition } from '../agent/chat-model';
import { executeRegisteredTool, registeredTools } from '../tools/registry';
import type { SupportAction, ToolRuntime } from '../tools/types';
import { requestToolActions } from '../tools/types';
import { fixture } from './pc-fixture';

type Fixture = ReturnType<typeof fixture>;
void test('售后已声明动作收窄后续参数，跨会话不串动作且执行端仍拒绝越权', async () => {
  const first = fixture(),
    second = fixture();
  await declareRequest(
    first,
    'update_support',
    '另一个问题是耳机没有声音',
    'new_issue',
  );
  await declareRequest(second, 'update_support', '现在请人工接手', 'handoff');
  const allowed = (f: Fixture) => {
    const definition = availableTools(f.runtime).find(
      (t) => t.function.name === 'update_support',
    )!;
    return (
      definition.function.parameters.properties as Record<
        string,
        { enum: string[] }
      >
    ).action.enum;
  };
  assert.deepEqual(allowed(first), ['new_issue']);
  assert.deepEqual(allowed(second), ['handoff']);
  assert.deepEqual(allowed(first), ['new_issue']);
  const before = structuredClone(first.runtime.draft);
  const rejected = await executeRegisteredTool(
    'update_support',
    {
      messageId: first.context.currentMessageId,
      action: 'continue',
    },
    first.context,
    first.runtime,
  );
  assert.equal(rejected.operation.failed, true);
  assert.ok('error' in rejected);
  assert.match(
    rejected.error!,
    /已声明supportAction=new_issue.*提交action=continue/,
  );
  assert.deepEqual(first.runtime.draft, before);
  const corrected = await executeRegisteredTool(
    'update_support',
    {
      messageId: first.context.currentMessageId,
      action: 'new_issue',
    },
    first.context,
    first.runtime,
  );
  assert.equal(corrected.operation.failed, false);
});
type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  tool_choice: string;
};

function response(delta: unknown, finishReason: 'stop' | 'tool_calls') {
  const payload = JSON.stringify({
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  return new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const answer = (content: string) => response({ content }, 'stop');
const calls = (...entries: [string, unknown][]) =>
  response(
    {
      tool_calls: entries.map(([name, args], index) => ({
        index,
        id: crypto.randomUUID(),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      })),
    },
    'tool_calls',
  );
const action = (
  value: Exclude<NonNullable<ToolRuntime['requestAction']>, 'pending'>,
  supportAction?: SupportAction,
) =>
  calls([
    'set_request_action',
    {
      action: value,
      sourceMessageId: 'current',
      ...(supportAction ? { supportAction } : {}),
      ...(value === 'other' ? { otherTopic: 'general' } : {}),
      ...(value === 'retrieve_knowledge' ? { knowledgeOnly: false } : {}),
    },
  ]);

async function declareRequest(
  f: Fixture,
  requestAction: Exclude<NonNullable<ToolRuntime['requestAction']>, 'pending'>,
  content: string,
  supportAction?: SupportAction,
) {
  const messageId = `request-${f.context.messages.length}`;
  f.context.currentMessageId = messageId;
  f.context.messages.push({
    id: messageId,
    role: 'user',
    content,
    taskId: f.context.taskId,
  });
  f.runtime.requestAction = 'pending';
  f.runtime.supportRequest = undefined;
  const declared = await executeRegisteredTool(
    'set_request_action',
    {
      action: requestAction,
      sourceMessageId: messageId,
      ...(supportAction ? { supportAction } : {}),
      ...(requestAction === 'other' ? { otherTopic: 'general' } : {}),
      ...(requestAction === 'retrieve_knowledge'
        ? { knowledgeOnly: false }
        : {}),
    },
    f.context,
    f.runtime,
  );
  assert.equal(declared.operation.failed, false);
  return messageId;
}

function mockModel(
  t: TestContext,
  handler: (request: ModelRequest) => Response,
) {
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => {
    assert.ok(typeof options.body === 'string');
    return handler(JSON.parse(options.body) as ModelRequest);
  });
}

function emptyFixture() {
  const f = fixture();
  f.runtime.draft = {};
  f.runtime.result = null;
  f.runtime.task = { ...f.runtime.task, draft: {}, result: null };
  return f;
}

const chat = (f: Fixture, message: string, onText?: (text: string) => void) =>
  runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: f.runtime.draft,
      result: f.runtime.result,
      task: f.runtime.task,
      currentTaskId: f.runtime.task.id,
      messages: [],
    },
    message,
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    undefined,
    undefined,
    onText,
  );

void test('评估答复只交付工具事实，模型编造性能保证不进入正文或流式输出', async (t) => {
  const f = fixture();
  let round = 0;
  const unsupported = '替换后性能完全不变，厂家保证所有游戏流畅。';
  mockModel(
    t,
    () =>
      [
        action('evaluate_plan'),
        calls(['evaluate_plan', { planId: 'plan-1' }]),
        answer(unsupported),
      ][round++] ?? answer(unsupported),
  );
  const streamed: string[] = [];
  const result = await chat(f, '只评估方案二，不执行调整。', (text) =>
    streamed.push(text),
  );
  assert.ok(
    result.facts.some((fact) => fact.tool === 'evaluate_plan' && !fact.failed),
  );
  assert.ok(!result.messages.at(-1)!.content.includes(unsupported));
  assert.match(result.messages.at(-1)!.content, /已评估当前指定方案/);
  assert.ok(streamed.every((text) => !text.includes(unsupported)));
  assert.equal(result.result?.selection, undefined);
});

void test('配机追问流式输出，未执行需求操作的文字不提前显示', async (t) => {
  const f = emptyFixture();
  let round = 0;
  mockModel(
    t,
    () =>
      [
        answer('尚未执行操作的文本'),
        action('clarify'),
        calls(['update_requirements', {}]),
        answer('请告诉我预算和主要用途。'),
      ][round++],
  );
  const chunks: string[] = [];
  const result = await chat(f, '配台式机', (text) => chunks.push(text));
  assert.deepEqual(chunks, ['请告诉我预算和主要用途。']);
  assert.equal(result.messages.at(-1)?.content, chunks.at(-1));
});

function noGeneration(request: ModelRequest) {
  assert.ok(
    request.tools.every(
      (tool) =>
        !['recommend_pc', 'assemble_build', 'select_prebuilt'].includes(
          tool.function.name,
        ),
    ),
  );
}

void test('空需求澄清完成字段核对后追问，空补丁不写任务且不配机', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, (request) => {
    if (count++ === 0) {
      assert.deepEqual(
        request.tools.map((tool) => tool.function.name),
        ['set_request_action'],
      );
      assert.equal(request.tool_choice, 'required');
      return action('clarify');
    }
    noGeneration(request);
    if (count === 2) return calls(['update_requirements', {}]);
    assert.equal(request.tool_choice, 'auto');
    return answer('请告诉我主机预算和主要用途。');
  });
  const result = await chat(f, '帮我配台电脑');
  assert.equal(count, 3);
  assert.equal(result.messages.at(-1)?.content, '请告诉我主机预算和主要用途。');
  assert.deepEqual(result.draft, {});
  assert.equal(result.result, null);
  assert.equal(f.saved.length, 0);
});

void test('需求只给预算时先保存预算再澄清用途，保持无配置状态', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('clarify');
    noGeneration(request);
    if (index === 1) return calls(['update_requirements', { budget: 8000 }]);
    return answer('预算已记录，主要用来做什么？');
  });
  const result = await chat(f, '想配电脑，预算8000元');
  assert.equal(count, 3);
  assert.equal(result.draft.budget, 8000);
  assert.equal(result.draft.purpose, undefined);
  assert.equal(result.result, null);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0]!.draft.budget, 8000);
  assert.equal(f.saved[0]!.result, null);
});

void test('仅保存需求不能用未执行的文本结束，纠正后实际保存且不生成', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('save_requirements');
    noGeneration(request);
    if (index === 1) return answer('预算用途已经保存。');
    if (index === 2) {
      assert.equal(request.tool_choice, 'required');
      assert.equal(f.saved.length, 0);
      return calls([
        'update_requirements',
        { budget: 8000, purpose: '游戏', mode: 'diy' },
      ]);
    }
    return answer('已记录8000元游戏DIY需求，暂不生成配置。');
  });
  const result = await chat(f, '先记预算8000元，打游戏，DIY，暂时别生成');
  assert.equal(count, 4);
  assert.equal(result.draft.budget, 8000);
  assert.equal(result.draft.purpose, '游戏');
  assert.equal(result.result, null);
  assert.equal(f.saved.length, 1);
  assert.ok(
    result.facts.some(
      (fact) => fact.tool === 'update_requirements' && !fact.failed,
    ),
  );
  assert.ok(result.facts.every((fact) => fact.tool !== 'recommend_pc'));
  assert.equal(
    result.messages.at(-1)?.content,
    '已记录8000元游戏DIY需求，暂不生成配置。',
  );
});

void test('仅保存持续不执行时有界失败，不保存虚假的成功回复', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, () =>
    count++ === 0
      ? action('save_requirements')
      : answer('已经记下预算和用途。'),
  );
  await assert.rejects(
    chat(f, '只记录8000元游戏主机，不生成'),
    /尚未执行完配置操作/,
  );
  assert.equal(count, 4);
  assert.equal(f.saved.length, 0);
});

void test('咨询中重复查询失败后仍能修正查询，不误入配机探索', async (t) => {
  const f = fixture();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('search_catalog');
    noGeneration(request);
    if (index === 1 || index === 2)
      return calls(['search_catalog', { category: 'gpu', unexpected: true }]);
    assert.equal(request.tool_choice, 'auto');
    assert.ok(
      request.tools.some((tool) => tool.function.name === 'search_catalog'),
    );
    if (index === 3) return calls(['search_catalog', { category: 'gpu' }]);
    return answer('已查到当前目录中的显卡商品，配置保持原样。');
  });
  const result = await chat(f, '只看看目录有哪些显卡');
  assert.equal(count, 5);
  const searches = result.facts.filter(
    (fact) => fact.tool === 'search_catalog',
  );
  assert.deepEqual(
    searches.map((fact) => fact.failed),
    [true, true, false],
  );
  assert.deepEqual(result.draft, before.draft);
  assert.deepEqual(result.result, before.result);
  assert.equal(f.saved.length, 0);
});

void test('已有完整配置的纯咨询不允许模型顺手改需求或重新生成', async (t) => {
  const f = fixture();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('other');
    noGeneration(request);
    assert.ok(
      request.tools.every(
        (tool) => tool.function.name !== 'update_requirements',
      ),
    );
    if (index === 1)
      return calls(
        ['update_requirements', { budget: 9000 }],
        ['recommend_pc', {}],
      );
    return answer('当前配置没有修改。');
  });
  const result = await chat(f, '只解释一下，先不要改配置');
  assert.equal(count, 3);
  assert.deepEqual(result.draft, before.draft);
  assert.deepEqual(result.result, before.result);
  assert.equal(f.saved.length, 0);
});

void test('浏览、咨询和评估动作从执行入口阻止确认、换件及显示器推荐', async () => {
  for (const requestAction of [
    'other',
    'search_catalog',
    'retrieve_knowledge',
    'explain_selection',
    'find_replacements',
    'evaluate_plan',
  ] as const) {
    const f = fixture();
    f.runtime.requestAction = requestAction;
    f.context.messages[0]!.content = '只看看商品或了解方案，不要修改或确认';
    const before = structuredClone({
      draft: f.runtime.draft,
      result: f.runtime.result,
    });
    const names = availableTools(f.runtime, 1).map(
      (tool) => tool.function.name,
    );
    if (requestAction === 'other') assert.deepEqual(names, []);
    else assert.ok(names.includes(requestAction));
    for (const [name, args] of [
      [
        'select_plan',
        { planId: 'plan-1', sourceMessageId: 'current', confirm: true },
      ],
      [
        'confirm_selections',
        { sourceMessageId: 'current', categories: ['gpu'] },
      ],
      [
        'replace_parts',
        {
          planId: 'plan-1',
          sourceMessageId: 'current',
          replacements: [{ oldId: 'gpu', newId: 'gpu-cheaper' }],
        },
      ],
      ['recommend_monitor', { budget: 199 }],
    ] as const) {
      assert.ok(!names.includes(name), `${requestAction} 不应提供 ${name}`);
      const output = await executeRegisteredTool(
        name,
        args,
        f.context,
        f.runtime,
      );
      assert.equal(output.operation.failed, true);
      assert.match(String(output.error), /当前用户动作不允许此操作/);
    }
    assert.deepEqual(
      { draft: f.runtime.draft, result: f.runtime.result },
      before,
    );
    assert.equal(f.saved.length, 0);
  }
});

void test('显示器目录浏览拒绝模型误报的确认调用并保持原方案', async (t) => {
  const f = fixture();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('other');
    assert.deepEqual(request.tools, []);
    if (index === 1)
      return calls([
        'select_plan',
        { planId: 'plan-1', sourceMessageId: 'current', confirm: true },
      ]);
    return answer('可以打开显示器商品目录查看型号。');
  });
  const result = await chat(f, '只看看显示器目录，不要确认主机');
  assert.equal(count, 3);
  assert.deepEqual({ draft: result.draft, result: result.result }, before);
  assert.equal(f.saved.length, 0);
  assert.equal(
    result.messages.at(-1)?.content,
    '可以打开显示器商品目录查看型号。',
  );
});

void test('售后停用后只开放人工请求，转人工后仍禁止检索操作步骤', async () => {
  const f = fixture();
  f.runtime.draft.support = {
    status: 'stopped',
    symptom: '电脑有焦味',
    history: [],
  };
  const messageId = await declareRequest(
    f,
    'update_support',
    '请帮我转人工',
    'handoff',
  );
  for (let step = 0; step < 2; step++) {
    assert.deepEqual(
      availableTools(f.runtime, 1).map((tool) => tool.function.name),
      ['update_support'],
    );
    const blocked = await executeRegisteredTool(
      'retrieve_knowledge',
      { query: '下一步排查操作', category: 'support' },
      f.context,
      f.runtime,
    );
    assert.equal(blocked.operation.failed, true);
    assert.match(String(blocked.error), /当前用户动作不允许此操作/);
    if (step === 0) {
      const handoff = await executeRegisteredTool(
        'update_support',
        { messageId, action: 'handoff' },
        f.context,
        f.runtime,
      );
      assert.equal(handoff.operation.failed, false);
      assert.equal(f.runtime.draft.support.status, 'handoff_requested');
    }
  }
  assert.equal(f.saved.length, 1);
  await declareRequest(f, 'retrieve_knowledge', '继续教我排查');
  const bypass = await executeRegisteredTool(
    'retrieve_knowledge',
    { query: '下一步排查操作', category: 'support' },
    f.context,
    f.runtime,
  );
  assert.equal(bypass.operation.failed, true);
  assert.match(String(bypass.error), /已停止自行排查/);
  await declareRequest(f, 'search_catalog', '只看看商品目录');
  assert.ok(
    availableTools(f.runtime, 1).some(
      (tool) => tool.function.name === 'search_catalog',
    ),
  );
});

void test('售后动作必须声明有效子动作，其他主动作不能夹带售后授权', async () => {
  for (const input of [
    { action: 'update_support' },
    { action: 'update_support', supportAction: 'unknown' },
    { action: 'update_support', supportAction: null },
    { action: 'other', otherTopic: 'support', supportAction: 'handoff' },
    { action: 'search_catalog', supportAction: 'resolved' },
  ]) {
    const f = fixture();
    f.runtime.requestAction = 'pending';
    const rejected = await executeRegisteredTool(
      'set_request_action',
      { ...input, sourceMessageId: 'current' },
      f.context,
      f.runtime,
    );
    assert.equal(rejected.operation.failed, true, JSON.stringify(input));
    assert.equal(f.runtime.requestAction, 'pending');
    assert.equal(f.runtime.supportRequest, undefined);
    assert.equal(f.saved.length, 0);
  }
});

void test('无需工具的回答必须明确售后或普通主题，其他动作不能夹带主题', async () => {
  for (const input of [
    { action: 'other' },
    { action: 'other', otherTopic: 'unknown' },
    { action: 'other', otherTopic: null },
    {
      action: 'update_support',
      supportAction: 'continue',
      otherTopic: 'support',
    },
    { action: 'search_catalog', otherTopic: 'general' },
  ]) {
    const f = fixture();
    f.runtime.requestAction = 'pending';
    const rejected = await executeRegisteredTool(
      'set_request_action',
      { ...input, sourceMessageId: 'current' },
      f.context,
      f.runtime,
    );
    assert.equal(rejected.operation.failed, true, JSON.stringify(input));
    assert.equal(f.runtime.requestAction, 'pending');
    assert.equal(f.runtime.otherTopic, undefined);
    assert.equal(f.runtime.supportRequest, undefined);
    assert.equal(f.saved.length, 0);
  }
});

void test('给定恢复子动作的模型输出后执行同一动作，不额外调用语义分类模型', async (t) => {
  const f = fixture();
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('update_support', 'resolved');
    noGeneration(request);
    if (index === 1)
      return calls([
        'update_support',
        { messageId: 'current', action: 'resolved' },
      ]);
    return answer('已记录你反馈的问题恢复。');
  });
  const result = await chat(f, '可以用了');
  assert.equal(count, 3, '主动作与售后子动作在同次模型工具调用中声明');
  assert.equal(result.draft.support?.status, 'resolved');
  assert.deepEqual(
    result.facts.map((fact) => [fact.tool, fact.failed]),
    [
      ['set_request_action', false],
      ['update_support', false],
    ],
  );
  assert.equal(f.saved.length, 1);
});

void test('已有方案重配必须重新生成，不能以选定旧方案冒充完成', async (t) => {
  const f = fixture();
  let mainCalls = 0;
  let branchCalls = 0;
  mockModel(t, (request) => {
    if (request.messages[0]?.content?.startsWith('你负责')) {
      branchCalls++;
      const input = JSON.parse(request.messages[1]!.content ?? '{}') as {
        candidate: { parts: { id: string }[] };
      };
      // 只模拟模型提交候选；真实组装、报价、预算及交付审核照常运行。
      return calls([
        'assemble_build',
        { productIds: input.candidate.parts.map((part) => part.id) },
      ]);
    }
    const index = mainCalls++;
    if (index === 0) return action('recommend');
    if (index === 1) {
      noGeneration(request);
      return calls(['recommend_pc', {}]);
    }
    if (index === 2)
      return calls(
        ['update_requirements', {}],
        ['select_plan', { planId: 'plan-1', sourceMessageId: 'current' }],
      );
    if (index === 3) {
      assert.equal(f.saved.length, 0, '选择旧方案不得抢先写入');
      return answer('已经重新生成配置。');
    }
    if (index === 4) {
      assert.deepEqual(
        request.tools.map((tool) => tool.function.name),
        ['recommend_pc'],
      );
      assert.equal(request.tool_choice, 'required');
      return calls(['recommend_pc', {}]);
    }
    return answer('新方案已重新生成并通过审核。');
  });
  const result = await chat(f, '按原需求重新配一套');
  assert.equal(mainCalls, 6);
  assert.ok(branchCalls > 0);
  assert.equal(
    result.facts.filter((fact) => fact.tool === 'recommend_pc' && !fact.failed)
      .length,
    1,
  );
  assert.ok(
    !result.facts.some((fact) => fact.tool === 'select_plan' && !fact.failed),
  );
  assert.ok(result.result?.plans.length);
  assert.ok(
    result.result.plans.every(
      (plan) => plan.deliveryAudit?.status === 'passed',
    ),
  );
  assert.equal(result.result.selection, undefined);
  assert.ok(f.saved.some((task) => task.result?.plans.length));
  // 推荐正文现在来自实际工具事实，不再复述模型笼统的“通过审核”。
  const delivered = result.messages.at(-1)!.content;
  assert.notEqual(delivered, '新方案已重新生成并通过审核。');
  for (const plan of result.result.plans)
    assert.ok(delivered.includes(`¥${plan.total}`));
  assert.match(delivered, /演示商品/);
  assert.match(delivered, /兼容资料仍待核对/);
});

void test('本次对话可临时记录需求，但不注册或开放任务与撤回工具', async () => {
  const f = fixture();
  f.runtime.requestAction = 'save_requirements';
  const removed = [
    'create_task',
    'switch_task',
    'reset_current_task',
    'undo_last_change',
  ];
  assert.ok(
    registeredTools.every(
      (tool) => !removed.includes(tool.definition.function.name),
    ),
  );
  assert.ok(requestToolActions.every((action) => !removed.includes(action)));
  assert.ok(
    availableTools(f.runtime, 2).every(
      (tool) => !removed.includes(tool.function.name),
    ),
  );
  const saved = await executeRegisteredTool(
    'update_requirements',
    { budget: 9000 },
    f.context,
    f.runtime,
  );
  assert.equal(saved.operation.failed, false);
  assert.equal(f.runtime.requirementsTaskId, 'task');
  assert.equal(f.runtime.requestAction, 'save_requirements');
  assert.equal(f.runtime.draft.budget, 9000);
  assert.equal(f.runtime.result, null);
  assert.equal(f.runtime.recommendationAttemptKeys, undefined);
});

void test('用户选定均衡方案时不能只口头答应，必须实际保存选择', async (t) => {
  const f = fixture();
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('select_plan');
    noGeneration(request);
    if (index === 1) return answer('好的，按均衡方案继续。');
    if (index === 2) {
      assert.equal(request.tool_choice, 'required');
      assert.equal(f.saved.length, 0);
      return calls([
        'select_plan',
        { planId: 'plan-1', sourceMessageId: 'current' },
      ]);
    }
    return answer('已选定均衡方案，后续按这套继续。');
  });
  const result = await chat(f, '先用均衡方案继续');
  assert.equal(count, 4);
  assert.equal(result.result?.selection?.planId, 'plan-1');
  assert.equal(result.result?.selection?.status, 'selected');
  assert.equal(result.draft.partSelections?.gpu, 'gpu');
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0]!.result?.selection?.planId, 'plan-1');
  assert.ok(
    result.facts.some((fact) => fact.tool === 'select_plan' && !fact.failed),
  );
});

void test('请求选择解释时必须调用解释工具，Embedding不可用仍交付数据库依据', async (t) => {
  const f = fixture();
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('explain_selection');
    noGeneration(request);
    if (index === 1) return answer('这颗CPU符合你的游戏需求。');
    if (index === 2) {
      assert.equal(request.tool_choice, 'required');
      return calls([
        'explain_selection',
        { planId: 'plan-1', category: 'cpu' },
      ]);
    }
    const output = JSON.parse(
      request.messages.filter((message) => message.role === 'tool').at(-1)!
        .content ?? '{}',
    ) as {
      data: {
        parts: {
          specs: unknown;
          knowledgeStatus: string;
          evidence: unknown[];
        }[];
      };
      operation: { failed: boolean };
    };
    assert.equal(output.operation.failed, false);
    assert.equal(output.data.parts[0]!.knowledgeStatus, 'unavailable');
    assert.deepEqual(output.data.parts[0]!.evidence, []);
    assert.deepEqual(
      output.data.parts[0]!.specs,
      f.catalog.parts.find((part) => part.id === 'cpu')!.specs,
    );
    return answer('数据库记载CPU接口为AM5，当前配置通过预算审核。');
  });
  const result = await chat(f, '解释一下均衡方案为什么选这颗CPU');
  assert.equal(count, 4);
  assert.ok(
    result.facts.some(
      (fact) => fact.tool === 'explain_selection' && !fact.failed,
    ),
  );
  assert.match(result.messages.at(-1)?.content ?? '', /^知识检索不可用/);
  assert.match(result.messages.at(-1)?.content ?? '', /AM5/);
  assert.deepEqual(result.draft, before.draft);
  assert.deepEqual(result.result, before.result);
  assert.equal(f.saved.length, 0);
});

void test('配机缺用途时即使模型查询后编出方案，也只追问缺项且不交付假配置', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, () => {
    const index = count++;
    if (index === 0) return action('recommend');
    if (index === 1)
      return calls([
        'update_requirements',
        {
          budget: 10000,
          mode: 'diy',
          seriesPreferences: { cpu: '9600X', gpu: 'RTX 5060' },
        },
      ]);
    if (index === 2) return calls(['search_catalog', { category: 'cpu' }]);
    return answer('为您整理三套配置，约9800元，总计6118元。');
  });
  const result = await chat(f, '坚持使用 AMD Ryzen 7 9600X, 5060');
  assert.match(result.messages.at(-1)!.content, /请告诉我主要用途/);
  assert.doesNotMatch(result.messages.at(-1)!.content, /9800|6118|三套/);
  assert.equal(result.result, null);
  assert.equal(result.draft.purpose, undefined);
  assert.equal(result.draft.budget, 10000);
});

void test('澄清型号冲突不能跳过已知需求保存', async (t) => {
  const f = emptyFixture();
  let count = 0;
  mockModel(t, (request) => {
    const index = count++;
    if (index === 0) return action('clarify');
    if (index === 1) return answer('CPU品牌型号冲突，请确认。');
    if (index === 2) {
      assert.equal(request.tool_choice, 'required');
      return calls([
        'update_requirements',
        { budget: 10000, purpose: '游戏', color: '黑色' },
      ]);
    }
    return answer('已记录预算用途和黑色需求，请确认CPU型号。');
  });
  const result = await chat(f, '1w 打游戏 9600x intel 黑色');
  assert.equal(result.draft.budget, 10000);
  assert.equal(result.draft.purpose, '游戏');
  assert.equal(result.draft.color, '黑色');
  assert.equal(result.result, null);
});
