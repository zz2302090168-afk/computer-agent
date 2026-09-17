import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import { runConversation } from '../agent/conversation';
import { assertSelectionReference } from '../tools/build/selection-reference';

void test('真实复合ID完整引用须与提交ID一致，不把前缀当成另一方案', async () => {
  const f = fixture();
  const first =
    'diy-demo-cpu|real-gpu|demo-memory|real-board|demo-psu|real-case|demo-ssd|real-cooler';
  const second = `${first}-2`;
  f.runtime.result!.plans[0].id = first;
  f.runtime.result!.plans[1].id = second;
  f.context.messages[0].content = `请选择${first}继续讨论。`;
  const before = structuredClone(f.runtime.result);
  const wrong = await executeRegisteredTool(
    'select_plan',
    { planId: second, sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  assert.equal(wrong.operation.failed, true);
  assert.deepEqual(f.runtime.result, before);
  assert.equal(f.saved.length, 0);
  // 后一条明确请求属于新一轮，失败去重记录不会跨轮保留。
  f.runtime.failedAttempts = new Map();
  f.context.messages[0].content = `请选择${second}继续讨论。`;
  const correct = await executeRegisteredTool(
    'select_plan',
    { planId: second, sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  assert.equal(correct.operation.failed, false);
  assert.equal(f.runtime.result!.selection?.planId, second);
  assert.doesNotThrow(() =>
    assertSelectionReference(
      `比较过${first}-extra，这次选第二套。`,
      second,
      f.runtime.result,
    ),
  );
  assert.throws(
    () =>
      assertSelectionReference(
        `${first}和${second}之间选一个`,
        second,
        f.runtime.result,
      ),
    /多个方案ID/,
  );
});

for (const message of [
  '只选第99套，没有就保持不变，不许改选。',
  '只选第九十九套，不许改选。',
  '选择方案99，不生成。',
  '不要选第二套，只选第99套。',
  '不要第二套，只选第99套。',
  '如果不要第一套，选择第二套。',
  '不是不要第一套，选择第二套。',
  '比较第一套，选择第二套。',
  '第一套或第二套都可以。',
  '不要第二套，选择第二套。',
  '不要第一套',
  '选第一套继续讨论。',
  '选 plan-0 继续讨论。',
])
  void test(`不匹配或多编号选择不得改动当前状态：${message}`, async () => {
    const f = fixture();
    f.context.messages[0].content = message;
    const before = structuredClone({
      draft: f.runtime.draft,
      result: f.runtime.result,
    });
    const response = await executeRegisteredTool(
      'select_plan',
      {
        planId: 'plan-1',
        sourceMessageId: 'current',
      },
      f.context,
      f.runtime,
    );
    assert.equal(response.operation.failed, true);
    assert.deepEqual(
      { draft: f.runtime.draft, result: f.runtime.result },
      before,
    );
    assert.equal(f.saved.length, 0);
  });

for (const message of [
  '选第二套',
  '选第2套',
  '选方案2',
  '选择 plan-1',
  '不要第一套，选择第二套。',
  '不要选第一套，选择第二套。',
  '不要选择第一套，选择第二套。',
  '不选第一套；选择第二套。',
  '不选择第一套，选择第二套。',
  '不要方案1,选择第2套。',
])
  void test(`合法对象仍可选定：${message}`, async () => {
    const f = fixture();
    f.context.messages[0].content = message;
    const response = await executeRegisteredTool(
      'select_plan',
      {
        planId: 'plan-1',
        sourceMessageId: 'current',
      },
      f.context,
      f.runtime,
    );
    assert.equal(response.operation.failed, false);
    assert.equal(f.runtime.result?.selection?.planId, 'plan-1');
    assert.equal(f.runtime.result?.selection?.status, 'selected');
  });

for (const exclusion of ['不要选第二套', '不要选择第二套'])
  void test(`完整排除分句后准确说明不存在的目标：${exclusion}`, async () => {
    const f = fixture();
    f.context.messages[0].content = `${exclusion}，只选第99套。不存在就告诉我。`;
    const before = structuredClone(f.runtime.result);
    const output = await executeRegisteredTool(
      'select_plan',
      { planId: 'plan-1', sourceMessageId: 'current' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true);
    assert.match(output.operation.error ?? '', /第99套方案不存在/);
    assert.deepEqual(f.runtime.result, before);
    assert.equal(f.saved.length, 0);
  });

void test('确认当前选定方案不需要用户重复编号', async () => {
  const f = fixture();
  f.context.messages[0].content = '选第二套';
  await executeRegisteredTool(
    'select_plan',
    { planId: 'plan-1', sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  f.context.messages[0].content = '确认当前这套主机';
  const response = await executeRegisteredTool(
    'select_plan',
    { planId: 'plan-1', sourceMessageId: 'current', confirm: true },
    f.context,
    f.runtime,
  );
  assert.equal(response.operation.failed, false);
  assert.equal(f.runtime.result?.selection?.status, 'confirmed');
});

function response(
  name?: string,
  args?: unknown,
  content = '随时都能恢复，而且这套显卡肯定性能很强。',
) {
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
    : { content };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

for (const scenario of ['session', 'explain', 'invalid'] as const)
  void test(`合并选定参数减少模型调用且保留后续及审核：${scenario}`, async (t) => {
    const f = fixture();
    let calls = 0;
    t.mock.method(
      globalThis,
      'fetch',
      async (...[_url, options]: Parameters<typeof fetch>) => {
        calls++;
        if (calls === 1)
          return response('set_request_action', {
            action: 'select_plan',
            sourceMessageId: 'current',
            sessionLifecycleQuestion: scenario === 'session',
            selectPlan: {
              planId: 'plan-1',
              sourceMessageId: 'current',
              confirm: false,
            },
          });
        assert.equal(typeof options?.body, 'string');
        if (typeof options?.body !== 'string')
          throw Error('测试请求缺少JSON正文');
        const body = JSON.parse(options.body);
        const results = body.messages
          .filter((m: { role: string }) => m.role === 'tool')
          .map((m: { content: string }) => JSON.parse(m.content));
        const selection = results.find(
          (r: { operation: { tool: string } }) =>
            r.operation.tool === 'select_plan',
        );
        assert.equal(selection.operation.failed, scenario === 'invalid');
        if (scenario === 'explain' && calls === 2)
          return response('explain_selection', {
            planId: 'plan-1',
            category: 'cpu',
          });
        return response(undefined, undefined, '已完成');
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
      scenario === 'invalid'
        ? '只选第99套，不许改选。'
        : scenario === 'explain'
          ? '选第二套继续讨论，不确认。再解释这套CPU。'
          : '选第二套继续讨论，不确认。刷新还能找回吗？',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    );
    assert.equal(calls, scenario === 'explain' ? 3 : 2);
    const answer = result.messages.at(-1)!.content;
    if (scenario === 'invalid') {
      assert.equal(result.result?.selection, undefined);
      assert.equal(f.saved.length, 0);
      assert.match(answer, /第99套方案不存在/);
    } else {
      assert.equal(result.result?.selection?.planId, 'plan-1');
      assert.equal(result.result?.selection?.status, 'selected');
      if (scenario === 'session') assert.match(answer, /清空.*无法恢复/);
      else
        assert.equal(
          result.facts.find((fact) => fact.tool === 'explain_selection')
            ?.failed,
          false,
        );
    }
  });

void test('其他动作不能借合并选定参数取得修改权限', async () => {
  const f = fixture();
  f.runtime.requestAction = 'pending';
  const result = await executeRegisteredTool(
    'set_request_action',
    {
      action: 'search_catalog',
      sourceMessageId: 'current',
      selectPlan: { planId: 'plan-1', sourceMessageId: 'current' },
    },
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.equal(f.runtime.requestAction, 'pending');
  assert.equal(f.saved.length, 0);
});

for (const followup of [
  'select_plan',
  'explain_selection',
  'find_replacements',
] as const)
  void test(`会话补充问题保留${followup}事实并阻止模型随意正文`, async (t) => {
    const f = fixture();
    let calls = 0;
    const streamed: string[] = [];
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (calls === 1)
        return response('set_request_action', {
          action: followup,
          sourceMessageId: 'current',
          sessionLifecycleQuestion: true,
        });
      if (calls === 2)
        return response(
          followup,
          followup === 'select_plan'
            ? { planId: 'plan-1', sourceMessageId: 'current', confirm: false }
            : {
                planId: 'plan-1',
                category: followup === 'explain_selection' ? 'cpu' : 'gpu',
              },
        );
      return response();
    });
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      followup === 'select_plan'
        ? '选第二套继续讨论，不确认。刷新还能找回吗？'
        : '请解释或查询第二套的部件。另外进入目录再返回会保留吗？',
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
      (value) => streamed.push(value),
    );
    const answer = result.messages.at(-1)!.content;
    assert.equal(calls, 3);
    assert.match(answer, /刷新页面.*都会清空，之后无法恢复/);
    assert.match(answer, /站内进入商品目录再返回时会保留/);
    assert.ok(!answer.includes('随时都能恢复'));
    assert.ok(!answer.includes('肯定性能很强'));
    assert.ok(!streamed.some((value) => value.includes('肯定性能很强')));
    if (followup === 'select_plan') {
      assert.equal(result.result?.selection?.status, 'selected');
      assert.match(answer, /总价¥8000/);
      assert.match(answer, /演示商品/);
    } else {
      assert.equal(result.result?.selection, undefined);
      assert.match(
        answer,
        followup === 'explain_selection' ? /目录价¥1000/ : /gpu-cheaper/,
      );
      assert.equal(
        result.facts.find((fact) => fact.tool === followup)?.failed,
        false,
      );
    }
  });

for (const scenario of ['catalog', 'invalid-selection'] as const)
  void test(`受证据约束的主要答复保留会话说明：${scenario}`, async (t) => {
    const f = fixture();
    const action = scenario === 'catalog' ? 'search_catalog' : 'select_plan';
    const mainAnswer =
      scenario === 'catalog'
        ? '查询到了测试CPU，目录价为1000元。'
        : '第99套方案不存在，当前选择保持不变。';
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls++;
      if (calls === 1)
        return response('set_request_action', {
          action,
          sourceMessageId: 'current',
          sessionLifecycleQuestion: true,
        });
      if (calls === 2)
        return response(
          action,
          scenario === 'catalog'
            ? { kind: 'part', category: 'cpu' }
            : { planId: 'plan-1', sourceMessageId: 'current' },
        );
      return response(undefined, undefined, mainAnswer);
    });
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      scenario === 'catalog'
        ? '查CPU目录。另外刷新后能恢复吗？'
        : '只选第99套，不许改选。另外刷新后能恢复吗？',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'session',
      f.context.onTaskChange,
    );
    const answer = result.messages.at(-1)!.content;
    assert.equal(calls, 3);
    if (scenario === 'catalog') {
      assert.match(answer, /测试CPU/);
      assert.match(answer, /目录价¥1000/);
      assert.ok(!answer.includes(mainAnswer));
    } else {
      assert.match(answer, /这次选定或确认操作未执行/);
      assert.match(answer, /第99套方案不存在/);
    }
    assert.match(answer, /都会清空，之后无法恢复/);
    assert.equal(result.result?.selection, undefined);
    assert.equal(f.saved.length, 0);
    assert.equal(
      result.facts.find((fact) => fact.tool === action)?.failed,
      scenario === 'invalid-selection',
    );
  });

for (const scenario of [
  'refusal',
  'repeat-refusal',
  'corrected',
  'explain',
  'catalog',
  'later-refusal',
] as const)
  void test(`选定拒绝正文合成仅依据实际后续结果：${scenario}`, async (t) => {
    const f = fixture();
    const select = (planId: string) => ({
      name: 'select_plan',
      args: { planId, sourceMessageId: 'current' },
    });
    const wrong = select('plan-0');
    const right = select('plan-1');
    const callsAfterAction =
      scenario === 'later-refusal'
        ? [right, wrong]
        : scenario === 'corrected'
          ? [wrong, right]
          : scenario === 'repeat-refusal'
            ? [wrong, wrong]
            : scenario === 'explain'
              ? [
                  wrong,
                  {
                    name: 'explain_selection',
                    args: { planId: 'plan-1', category: 'cpu' },
                  },
                ]
              : scenario === 'catalog'
                ? [wrong, { name: 'search_catalog', args: { category: 'cpu' } }]
                : [wrong];
    let calls = 0;
    const streamed: string[] = [];
    t.mock.method(globalThis, 'fetch', async () => {
      const index = calls++;
      if (index === 0)
        return response('set_request_action', {
          action: 'select_plan',
          sourceMessageId: 'current',
          sessionLifecycleQuestion: true,
        });
      const call = callsAfterAction[index - 1];
      if (call) return response(call.name, call.args);
      return response(
        undefined,
        undefined,
        scenario === 'catalog'
          ? '目录查询到了测试CPU，目录价1000元，为演示商品。'
          : '这里有三套主机，而且肯定性能很强，不需要标注演示。',
      );
    });
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: 'task',
        messages: [],
      },
      '选择第二套，按要求解释或查询。另外刷新能恢复吗？',
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
      (value) => streamed.push(value),
    );
    const answer = result.messages.at(-1)!.content;
    assert.equal(calls, callsAfterAction.length + 2);
    assert.ok(
      result.facts.some((fact) => fact.tool === 'select_plan' && fact.failed),
    );
    assert.match(answer, /都会清空，之后无法恢复/);
    assert.ok(!answer.includes('这里有三套主机'));
    assert.ok(!answer.includes('肯定性能很强'));
    assert.ok(!streamed.some((value) => value.includes('肯定性能很强')));
    if (scenario === 'corrected') {
      assert.ok(!answer.includes('这次选定或确认操作未执行'));
      assert.match(answer, /已选定当前主机方案/);
      assert.match(answer, /演示商品/);
    } else {
      assert.match(answer, /这次选定或确认操作未执行/);
      assert.ok(!answer.includes('已选定当前主机方案'));
      if (scenario === 'explain') assert.match(answer, /目录价¥1000/);
      if (scenario === 'catalog') assert.match(answer, /目录查询到了测试CPU/);
    }
    if (scenario === 'corrected' || scenario === 'later-refusal') {
      assert.equal(result.result?.selection?.planId, 'plan-1');
      assert.equal(result.result?.selection?.status, 'selected');
      assert.equal(f.saved.length, 1);
    } else {
      assert.equal(result.result?.selection, undefined);
      assert.equal(f.saved.length, 0);
    }
  });
