import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { runConversation } from '../agent/conversation';
import { executeRegisteredTool } from '../tools/registry';
import type { SupportAction } from '../tools/types';
import { renderSupportReply, supportQuestions } from '../support/reply';
import { supportKnowledge } from '../../knowledge/support';
import { fixture } from './pc-fixture';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';

type Fixture = ReturnType<typeof fixture>;
type ModelStep = string | [string, Record<string, unknown>];
const unsafeReply =
  '模型自由补充标记：拆开机箱并重插显卡，已确定是主板损坏；我已通知客服来联系你。';
const firstStep = supportKnowledge.find(
  (item) =>
    item.topicId === 'support-no-display' && item.title.includes('步骤1'),
)!;
const supportAction = (action: SupportAction): ModelStep => [
  'set_request_action',
  {
    action: 'update_support',
    supportAction: action,
    sourceMessageId: 'current',
  },
];
const lookup: ModelStep = [
  'retrieve_knowledge',
  {
    query: '步骤1 显示器自身工作',
    category: 'support',
    topicId: 'support-no-display',
  },
];

// 模型动作与正文均由测试给定，只验证真实调用链的交付边界，不证明模型语义分类。

function modelResponse(step: ModelStep) {
  const delta =
    typeof step === 'string'
      ? { content: step }
      : {
          tool_calls: [
            {
              index: 0,
              id: crypto.randomUUID(),
              type: 'function',
              function: {
                name: step[0],
                arguments: JSON.stringify(step[1]),
              },
            },
          ],
        };
  return new Response(
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta,
          finish_reason: typeof step === 'string' ? 'stop' : 'tool_calls',
        },
      ],
    })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

async function conversation(
  t: TestContext,
  f: Fixture,
  steps: ModelStep[],
  options: {
    message?: string;
    signal?: AbortSignal;
    embeddings?: (
      url: unknown,
      options: RequestInit,
    ) => Response | Promise<Response>;
  } = {},
) {
  let modelCalls = 0;
  t.mock.method(globalThis, 'fetch', (url: unknown, request: RequestInit) => {
    if (String(url).endsWith('/embeddings'))
      return (options.embeddings ?? embeddingFetch)(url, request);
    const next = steps[modelCalls++];
    assert.ok(next !== undefined, '出现未预期的额外模型调用');
    return modelResponse(next);
  });
  const output = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: f.runtime.draft,
      result: f.runtime.result,
      task: f.runtime.task,
      currentTaskId: f.context.taskId,
      messages: [],
    },
    options.message ?? '风扇转但是屏幕无信号',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    options.signal,
    embeddingConfig,
  );
  return { output, modelCalls, reply: output.messages.at(-1)!.content };
}

async function declare(f: Fixture, action: SupportAction = 'continue') {
  f.runtime.requestAction = 'pending';
  const output = await executeRegisteredTool(
    'set_request_action',
    {
      action: 'update_support',
      supportAction: action,
      sourceMessageId: f.context.currentMessageId,
    },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
}

async function retrieve(f: Fixture, topicId?: string) {
  const output = await executeRegisteredTool(
    'retrieve_knowledge',
    {
      query: '步骤1 显示器自身工作',
      category: 'support',
      ...(topicId ? { topicId } : {}),
    },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  return output;
}

function controlledQuestion(reply: string | undefined, question: string) {
  assert.ok(reply, '缺少售后受控正文');
  assert.ok(reply.includes(question), '缺少受控澄清问题');
  assert.ok(!reply.includes('模型自由补充标记'));
  assert.ok(!reply.includes('拆开机箱'));
  assert.ok(
    !reply.includes(firstStep.content),
    '未成功交付证据时不得输出操作步骤',
  );
}

void test('知识成功且实际保存后只交付入选原文，模型自由拆机建议不透传', async (t) => {
  const f = fixture();
  const before = structuredClone(f.runtime.result);
  const result = await conversation(t, f, [
    supportAction('continue'),
    lookup,
    [
      'update_support',
      { messageId: 'current', action: 'continue', knowledgeId: firstStep.id },
    ],
    unsafeReply,
  ]);
  assert.equal(result.modelCalls, 4, '不得额外调用审核模型');
  assert.ok(
    result.reply.includes(firstStep.content),
    '应原样交付本轮入选知识块',
  );
  assert.ok(!result.reply.includes('模型自由补充标记'));
  assert.ok(!result.reply.includes('重插显卡'));
  assert.ok(!result.reply.includes('已确定是主板损坏'));
  assert.equal(f.saved.at(-1)!.draft.support?.currentStepId, firstStep.id);
  assert.deepEqual(result.output.result, before);
});

void test('检索失败且没有可用本地主题时仅交付受控问题，禁止透传自由正文', async (t) => {
  const f = fixture();
  const result = await conversation(
    t,
    f,
    [
      supportAction('continue'),
      ['retrieve_knowledge', { query: '问题不明确', category: 'support' }],
      [
        'update_support',
        { messageId: 'current', action: 'continue', questionId: 'symptom' },
      ],
      unsafeReply,
    ],
    {
      embeddings: () =>
        Response.json({ error: '测试服务不可用' }, { status: 503 }),
    },
  );
  controlledQuestion(result.reply, supportQuestions.symptom);
  assert.equal(result.output.draft.support?.status, 'active');
  assert.equal(result.output.draft.support?.currentStepId, undefined);
  assert.equal(result.modelCalls, 4);
});

void test('仅检索售后资料但没有保存所选步骤时也不能交付模型自由操作', async (t) => {
  const f = fixture();
  const result = await conversation(t, f, [
    [
      'set_request_action',
      {
        action: 'retrieve_knowledge',
        sourceMessageId: 'current',
        knowledgeOnly: false,
      },
    ],
    lookup,
    unsafeReply,
  ]);
  controlledQuestion(result.reply, supportQuestions.symptom);
  assert.equal(f.saved.length, 0);
});

void test('给定空检索事实可保存报告，但没有有效证据时只问默认澄清问题', async () => {
  const f = fixture();
  await declare(f);
  // 当前合法主题都有资料，真实检索不会返回空；此处单独验证空结果出口。
  f.runtime.supportRetrieval = {
    taskId: f.context.taskId,
    messageId: f.context.currentMessageId,
    status: 'empty',
    source: 'none',
  };
  f.runtime.supportEvidence = new Map();
  const saved = await executeRegisteredTool(
    'update_support',
    {
      messageId: 'current',
      action: 'continue',
    },
    f.context,
    f.runtime,
  );
  assert.equal(saved.operation.failed, false);
  controlledQuestion(
    renderSupportReply(f.runtime, f.context),
    supportQuestions.symptom,
  );
  assert.equal(f.saved.length, 1);
});

void test('不存在的售后主题不回退到其他主题，不留下可交付证据', async () => {
  const f = fixture();
  await declare(f);
  const output = await executeRegisteredTool(
    'retrieve_knowledge',
    {
      query: '显示器无信号',
      category: 'support',
      topicId: 'support-topic-not-present',
    },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
  assert.equal(f.runtime.supportEvidence?.size ?? 0, 0);
  controlledQuestion(
    renderSupportReply(f.runtime, f.context),
    supportQuestions.symptom,
  );
  assert.equal(f.saved.length, 0);
});

void test('受控问题与知识步骤互斥，停止、恢复和人工请求不能夹带问题', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  for (const [action, extra] of [
    ['continue', { knowledgeId: firstStep.id, questionId: 'symptom' }],
    ['continue', { questionId: 'free-form-question' }],
    ['stop', { questionId: 'hazards' }],
    ['resolved', { questionId: 'timing' }],
    ['handoff', { questionId: 'device' }],
  ] as const) {
    const f = fixture();
    await declare(f, action);
    if ('knowledgeId' in extra) await retrieve(f, 'support-no-display');
    const output = await executeRegisteredTool(
      'update_support',
      {
        messageId: 'current',
        action,
        ...extra,
      },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true);
    assert.equal(f.runtime.supportDelivery, undefined);
    assert.equal(f.saved.length, 0);
  }
  for (const action of ['continue', 'new_issue'] as const) {
    const f = fixture();
    await declare(f, action);
    const output = await executeRegisteredTool(
      'update_support',
      {
        messageId: 'current',
        action,
        questionId: 'previous_checks',
      },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, false);
    controlledQuestion(
      renderSupportReply(f.runtime, f.context),
      supportQuestions.previous_checks,
    );
  }
});

void test('知识ID必须属于当前消息和任务，旧证据及旧交付事实不得复用', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  for (const boundary of ['message', 'task'] as const) {
    const f = fixture();
    await declare(f);
    await retrieve(f, 'support-no-display');
    const saved = await executeRegisteredTool(
      'update_support',
      {
        messageId: 'current',
        action: 'continue',
        knowledgeId: firstStep.id,
      },
      f.context,
      f.runtime,
    );
    assert.equal(saved.operation.failed, false);
    if (boundary === 'message') {
      f.context.currentMessageId = 'next-message';
      f.context.messages.push({
        id: 'next-message',
        role: 'user',
        taskId: 'task',
        content: '还是不行',
      });
    } else {
      f.context.taskId = 'next-task';
      f.runtime.task = { ...f.runtime.task, id: 'next-task' };
      f.context.messages[0]!.taskId = 'next-task';
    }
    await declare(f);
    const saveCount = f.saved.length;
    const rejected = await executeRegisteredTool(
      'update_support',
      {
        messageId: f.context.currentMessageId,
        action: 'continue',
        knowledgeId: firstStep.id,
      },
      f.context,
      f.runtime,
    );
    assert.equal(rejected.operation.failed, true, boundary);
    assert.equal(f.saved.length, saveCount);
    controlledQuestion(
      renderSupportReply(f.runtime, f.context),
      supportQuestions.symptom,
    );
  }
});

void test('同一轮只交付一个步骤，收到下一轮用户反馈并检索后才能前进', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  const nextStep = supportKnowledge.find(
    (item) =>
      item.topicId === firstStep.topicId && item.title.includes('步骤2'),
  );
  assert.ok(nextStep);
  await declare(f);
  await retrieve(f, firstStep.topicId);
  const choose = (knowledgeId: string) =>
    executeRegisteredTool(
      'update_support',
      {
        messageId: f.context.currentMessageId,
        action: 'continue',
        knowledgeId,
      },
      f.context,
      f.runtime,
    );
  assert.equal((await choose(firstStep.id)).operation.failed, false);
  assert.equal((await choose(nextStep.id)).operation.failed, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.runtime.supportDelivery?.knowledgeId, firstStep.id);
  assert.ok(
    renderSupportReply(f.runtime, f.context)?.includes(firstStep.content),
  );
  f.context.currentMessageId = 'next-feedback';
  f.context.messages.push({
    id: 'next-feedback',
    role: 'user',
    taskId: f.context.taskId,
    content: '显示器菜单正常，下一步呢',
  });
  await declare(f);
  await retrieve(f, firstStep.topicId);
  assert.equal((await choose(nextStep.id)).operation.failed, false);
  assert.equal(f.saved.length, 2);
  assert.equal(f.runtime.supportDelivery?.knowledgeId, nextStep.id);
  assert.ok(
    renderSupportReply(f.runtime, f.context)?.includes(nextStep.content),
  );
});

void test('已经选定步骤后不能借改问澄清问题绕过本轮一步限制', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  const nextStep = supportKnowledge.find(
    (item) =>
      item.topicId === firstStep.topicId && item.title.includes('步骤2'),
  );
  assert.ok(nextStep);
  await declare(f);
  await retrieve(f, firstStep.topicId);
  const choose = (extra: Record<string, unknown>) =>
    executeRegisteredTool(
      'update_support',
      { messageId: f.context.currentMessageId, action: 'continue', ...extra },
      f.context,
      f.runtime,
    );
  assert.equal(
    (await choose({ knowledgeId: firstStep.id })).operation.failed,
    false,
  );
  await choose({ questionId: 'symptom' });
  const saveCount = f.saved.length;
  assert.equal(
    (await choose({ knowledgeId: nextStep.id })).operation.failed,
    true,
  );
  assert.equal(f.saved.length, saveCount);
  assert.ok(
    !renderSupportReply(f.runtime, f.context)?.includes(nextStep.content),
  );
});

void test('保存失败不产生supportDelivery，最终不能冒称已保存或交付检索步骤', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  await declare(f);
  await retrieve(f, 'support-no-display');
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  f.context.onUpdate = async () => {
    throw Error('测试保存失败');
  };
  const output = await executeRegisteredTool(
    'update_support',
    {
      messageId: 'current',
      action: 'continue',
      knowledgeId: firstStep.id,
    },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
  assert.equal(f.runtime.supportDelivery, undefined);
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
  const reply = renderSupportReply(f.runtime, f.context);
  controlledQuestion(reply, supportQuestions.symptom);
  assert.ok(!reply?.includes('已记录'));
  const g = fixture();
  g.context.onUpdate = async () => {
    throw Error('测试保存失败');
  };
  const final = await conversation(t, g, [
    supportAction('continue'),
    lookup,
    [
      'update_support',
      { messageId: 'current', action: 'continue', knowledgeId: firstStep.id },
    ],
    unsafeReply,
  ]);
  controlledQuestion(final.reply, supportQuestions.symptom);
  assert.ok(!final.reply.includes('已记录'));
  assert.equal(g.saved.length, 0);
});

void test('Embedding先失败后合法本地主题检索成功，不被旧不可用标记阻断', async (t) => {
  t.mock.method(globalThis, 'fetch', () => Response.json({}, { status: 503 }));
  const f = fixture();
  await declare(f);
  await retrieve(f);
  assert.equal(f.runtime.supportRetrieval?.status, 'failed');
  assert.equal(f.runtime.supportEvidence?.size ?? 0, 0);
  await retrieve(f, 'support-no-display');
  assert.equal(f.runtime.supportRetrieval?.status, 'available');
  assert.equal(f.runtime.supportRetrieval?.source, 'local');
  assert.deepEqual(f.runtime.supportEvidence?.get(firstStep.id), {
    taskId: 'task',
    messageId: 'current',
    source: 'local',
  });
  const output = await executeRegisteredTool(
    'update_support',
    {
      messageId: 'current',
      action: 'continue',
      knowledgeId: firstStep.id,
    },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  // 即使同轮较早查询留下旧提示，当前有效的交付事实仍必须生效。
  f.runtime.knowledgeUnavailable = true;
  assert.ok(
    renderSupportReply(f.runtime, f.context)?.includes(firstStep.content),
  );
});

void test('停止、真实人工请求和恢复仅报告实际状态，模型额外操作或根因不透传', async (t) => {
  for (const action of ['stop', 'handoff', 'resolved'] as const) {
    const f = fixture();
    const result = await conversation(t, f, [
      supportAction(action),
      ['update_support', { messageId: 'current', action }],
      unsafeReply,
    ]);
    assert.ok(!result.reply.includes('模型自由补充标记'));
    assert.ok(!result.reply.includes('拆开机箱'));
    assert.ok(!result.reply.includes('已确定是主板损坏'));
    assert.ok(!result.reply.includes('我已通知客服'));
    assert.equal(f.saved.length, 1);
    if (action === 'stop') {
      assert.equal(result.output.draft.support?.status, 'stopped');
      assert.match(result.reply, /停止/);
    } else if (action === 'handoff') {
      assert.equal(result.output.draft.support?.status, 'handoff_requested');
      assert.match(result.reply, /已记录/);
      assert.match(result.reply, /未|没有/);
    } else {
      assert.equal(result.output.draft.support?.status, 'resolved');
      assert.match(result.reply, /恢复/);
    }
  }
});

void test('已经停止后的无效继续请求仍只说明停止，不透传模型拆机建议', async (t) => {
  const f = fixture();
  f.runtime.draft.support = { status: 'stopped', symptom: '焦味', history: [] };
  const result = await conversation(t, f, [
    supportAction('continue'),
    ['update_support', { messageId: 'current', action: 'continue' }],
    unsafeReply,
  ]);
  assert.match(result.reply, /停止/);
  assert.ok(!result.reply.includes('模型自由补充标记'));
  assert.ok(!result.reply.includes('拆开机箱'));
  assert.equal(result.output.draft.support?.status, 'stopped');
  assert.equal(f.saved.length, 0);
});

void test('无需工具的售后咨询仍走受控出口，普通售前保留原模型正文', async (t) => {
  for (const otherTopic of ['support', 'general'] as const) {
    const f = fixture();
    const text =
      otherTopic === 'support' ? unsafeReply : '当前主机预算是8000元。';
    const result = await conversation(t, f, [
      [
        'set_request_action',
        { action: 'other', otherTopic, sourceMessageId: 'current' },
      ],
      text,
    ]);
    if (otherTopic === 'support')
      controlledQuestion(result.reply, supportQuestions.symptom);
    else assert.equal(result.reply, text);
    assert.equal(f.saved.length, 0);
    assert.equal(result.modelCalls, 2);
  }
});

void test('用户取消中止售后流程，不降级为可交付步骤或保存报告', async (t) => {
  const f = fixture();
  const controller = new AbortController();
  await assert.rejects(
    conversation(t, f, [supportAction('continue'), lookup, unsafeReply], {
      signal: controller.signal,
      embeddings: () => {
        controller.abort(new Error('测试用户取消'));
        throw controller.signal.reason;
      },
    }),
    /测试用户取消/,
  );
  assert.equal(f.saved.length, 0);
});
