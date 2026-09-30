import test from 'node:test';
import assert from 'node:assert/strict';
import { completeRequirements } from '../agent/conversation-state';
import { recommend } from '../services/recommend';
import { executeRegisteredTool } from '../tools/registry';
import { fixture } from './pc-fixture';
import { embeddingFetch } from './embedding-fixture';

type Fixture = ReturnType<typeof fixture>;
void test('S23 查询参数修正成功后，不再沿用上次失败的阻塞状态', async () => {
  const f = fixture();
  assert.equal(
    (
      await call(f, 'find_replacements', {
        planId: 'plan-1',
        category: 'gpu',
        sourceMessageId: 'current',
      })
    ).operation.failed,
    true,
  );
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
  });
  successful(result);
  assert.notEqual(f.runtime.exploration?.status, 'blocked');
});
void test('S22 跨轮新增类别沿用原查询范围，明确清空时才取消过滤', async () => {
  const f = fixture();
  const first = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    modelKeyword: 'gpu-more-power',
  });
  successful(first);
  f.context.messages.push({
    role: 'assistant',
    taskId: 'task',
    content: '单件查询无可用项',
    replacementQueries: [{ role: 'tool', content: JSON.stringify(first) }],
  });
  const next = await call(f, 'find_replacements', {
    planId: 'plan-1',
    items: [{ category: 'gpu' }, { category: 'psu' }],
  });
  successful(next);
  assert.ok('data' in next);
  assert.equal((next.data as { matchCount: number }).matchCount, 1);
  const cleared = await call(f, 'find_replacements', {
    planId: 'plan-1',
    items: [{ category: 'gpu', modelKeyword: '' }, { category: 'psu' }],
  });
  successful(cleared);
  assert.ok('data' in cleared);
  assert.ok((cleared.data as { matchCount: number }).matchCount > 1);
  const other = await call(f, 'find_replacements', {
    planId: 'plan-2',
    items: [{ category: 'gpu' }, { category: 'psu' }],
  });
  successful(other);
  assert.ok('data' in other);
  assert.ok(
    (other.data as { matchCount: number }).matchCount > 1,
    '其他方案不能继承查询',
  );
});
void test('S19 联动查询整体审核两件，保留其余六件且不写状态', async () => {
  const f = fixture(),
    before = state(f);
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    items: [
      { category: 'gpu', modelKeyword: 'gpu-more-power' },
      { category: 'psu' },
    ],
  });
  successful(result);
  assert.ok('data' in result);
  const data = result.data as {
    candidates: {
      replacements: { oldId: string; newId: string }[];
      total: number;
    }[];
    preservedProductIds: string[];
  };
  assert.equal(data.candidates.length, 1);
  assert.deepEqual(data.candidates[0].replacements, [
    { oldId: 'gpu', newId: 'gpu-more-power' },
    { oldId: 'psu', newId: 'psu-1000' },
  ]);
  assert.equal(data.candidates[0].total, 8000);
  assert.equal(data.preservedProductIds.length, 6);
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('S20 联动组合分页继续探索，不能将未检查组合说成无解', async () => {
  const f = fixture();
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    items: [{ category: 'gpu' }, { category: 'psu' }],
    limit: 1,
  });
  successful(result);
  assert.ok('data' in result);
  const data = result.data as {
    matchCount: number;
    nextOffset: number;
    candidates: unknown[];
    rejected: unknown[];
  };
  assert.ok(data.matchCount > 1);
  assert.equal(data.nextOffset, 1);
  assert.equal(data.candidates.length + data.rejected.length, 1);
});

void test('S21 联动查询拒绝重复类别和混用参数，保留原方案', async () => {
  for (const args of [
    { items: [{ category: 'gpu' }, { category: 'gpu' }] },
    { category: 'gpu', items: [{ category: 'psu' }] },
    { items: [] },
    { items: [{ category: 'gpu', surprise: true }] },
  ]) {
    const f = fixture(),
      before = state(f);
    assert.equal(
      (await call(f, 'find_replacements', { planId: 'plan-1', ...args }))
        .operation.failed,
      true,
    );
    assert.deepEqual(state(f), before);
  }
});
const state = (f: Fixture) =>
  structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
  });
const call = (f: Fixture, name: string, args: unknown) =>
  executeRegisteredTool(name, args, f.context, f.runtime);
const successful = (result: Awaited<ReturnType<typeof call>>) =>
  assert.equal(result.operation.failed, false, JSON.stringify(result));

void test('S24 只读评估本轮禁止修改，下一轮仅明确接受当前具体建议才执行', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  f.context.messages[0]!.content = '还能改进吗？';
  successful(await call(f, 'evaluate_plan', { planId: 'plan-1' }));
  const suggestion = f.runtime.result!.evaluation!.suggestions.find(
    (item) => item.valid,
  )!;
  assert.ok(suggestion);
  const evaluated = state(f);
  for (const [name, args] of [
    [
      'replace_parts',
      {
        planId: 'plan-1',
        sourceMessageId: 'current',
        replacements: [
          {
            oldId: suggestion.oldProductId,
            newId: suggestion.candidateProductId,
          },
        ],
      },
    ],
    ['update_requirements', { budget: 9000 }],
    [
      'apply_suggestion',
      { suggestionId: suggestion.id, sourceMessageId: 'current' },
    ],
  ] as const) {
    assert.equal((await call(f, name, args)).operation.failed, true);
    assert.deepEqual(state(f), evaluated);
  }

  f.runtime.readOnlyEvaluationTurn = false;
  f.context.messages.push({
    id: 'old-accept',
    role: 'user',
    taskId: 'task',
    content: `换成 ${suggestion.candidateProductId}`,
  });
  f.context.currentMessageId = 'consult';
  f.context.messages.push({
    id: 'consult',
    role: 'user',
    taskId: 'task',
    content: '这个建议可以换吗？',
  });
  assert.equal(
    (
      await call(f, 'apply_suggestion', {
        suggestionId: suggestion.id,
        sourceMessageId: 'old-accept',
      })
    ).operation.failed,
    true,
  );
  assert.deepEqual(state(f), evaluated);

  f.context.currentMessageId = 'accept';
  f.context.messages.push({
    id: 'accept',
    role: 'user',
    taskId: 'task',
    content: `就按建议换成 ${suggestion.candidateProductId}`,
  });
  successful(
    await call(f, 'apply_suggestion', {
      suggestionId: suggestion.id,
      sourceMessageId: 'accept',
    }),
  );
  assert.equal(
    f.runtime.draft.partSelections?.[suggestion.category],
    suggestion.candidateProductId,
  );
  assert.equal(f.runtime.result!.selection, undefined);
});

void test('S25 本轮更新预算也不能重启探索并重置候选额度', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  f.context.modelConfig = undefined;
  successful(await call(f, 'recommend_pc', {}));
  successful(await call(f, 'update_requirements', { budget: 9000 }));
  const result = await call(f, 'recommend_pc', {});
  assert.equal(result.operation.failed, true);
  assert.match('error' in result ? (result.error ?? '') : '', /不能重新开始/);
});

void test('配置推荐不调用Embedding，只使用业务规则和商品数据库', async (t) => {
  const f = fixture();
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('配置推荐不应发起模型或向量网络请求');
  });
  f.context.modelConfig = undefined;
  f.runtime.result = null;
  const result = await call(f, 'recommend_pc', {});
  successful(result);
  const saved = f.saved.at(-1)?.result;
  assert.equal(saved?.plans.length, 3);
  assert.deepEqual(saved?.evidence, []);

  const assembled = fixture();
  assembled.context.modelConfig = undefined;
  const productIds = assembled.runtime.result!.plans[0]!.parts.map(
    (part) => part.id,
  );
  assembled.runtime.result = null;
  successful(await call(assembled, 'assemble_build', { productIds }));
  const assembledResult = assembled.saved.at(-1)?.result;
  assert.equal(assembledResult?.plans.length, 1);
  assert.deepEqual(assembledResult?.evidence, []);
});

void test('S26 主循环最多提交三个不重复候选，参数顺序不能绕过去重', async () => {
  const f = fixture(),
    base = f.runtime.result!.plans[1]!.parts.map((part) => part.id),
    withGpu = (id: string) =>
      base.map((partId) => (partId === 'gpu' ? id : partId));
  const first = await call(f, 'assemble_build', {
    productIds: withGpu('missing-a'),
  });
  assert.equal(first.operation.failed, true);
  const repeated = await call(f, 'assemble_build', {
    productIds: [...withGpu('missing-a')].reverse(),
  });
  assert.equal(repeated.operation.failed, true);
  assert.match('error' in repeated ? (repeated.error ?? '') : '', /已经提交过/);
  for (const id of ['missing-b', 'missing-c'])
    assert.equal(
      (await call(f, 'assemble_build', { productIds: withGpu(id) })).operation
        .failed,
      true,
    );
  const capped = await call(f, 'assemble_build', {
    productIds: withGpu('missing-d'),
  });
  assert.equal(capped.operation.failed, true);
  assert.match('error' in capped ? (capped.error ?? '') : '', /修正上限/);
});

void test('S27 建议执行引用当前消息，保存失败不留下半更新', async () => {
  const f = fixture(),
    before = state(f);
  f.runtime.result!.evaluation = {
    planId: 'plan-1',
    issues: [],
    directions: [],
    evidence: [],
    createdAt: Date.now(),
    suggestions: [
      {
        id: 'replace-one',
        planId: 'plan-1',
        category: 'gpu',
        oldProductId: 'gpu',
        candidateProductId: 'gpu-cheaper',
        summary: '换显卡一',
        valid: true,
      },
      {
        id: 'replace-two',
        planId: 'plan-1',
        category: 'gpu',
        oldProductId: 'gpu',
        candidateProductId: 'gpu-upper',
        summary: '换显卡二',
        valid: true,
      },
    ],
  };
  f.runtime.result!.evaluation!.suggestions = [
    f.runtime.result!.evaluation!.suggestions[0]!,
  ];
  const unchanged = state(f);
  f.runtime.failedAttempts = new Map();
  f.context.messages[0]!.content = '不错，就按建议换成 gpu-cheaper';
  f.context.onUpdate = async () => {
    throw Error('测试：保存失败');
  };
  const failed = await call(f, 'apply_suggestion', {
    suggestionId: 'replace-one',
    sourceMessageId: 'current',
  });
  assert.equal(failed.operation.failed, true);
  assert.deepEqual(state(f), unchanged);
  assert.notDeepEqual(state(f), before);
});

void test('S01 选定均衡方案会保存实际选择，且不会把选择当成确认或重配', async () => {
  const f = fixture();
  const original = f.runtime.result!.plans.map((plan) =>
    plan.parts.map((part) => part.id),
  );
  successful(
    await call(f, 'select_plan', {
      planId: 'plan-1',
      sourceMessageId: 'current',
    }),
  );
  assert.equal(f.saved.length, 1);
  assert.equal(f.runtime.result!.selection?.planId, 'plan-1');
  assert.equal(f.runtime.result!.selection?.status, 'selected');
  assert.equal(f.saved[0].result?.selection?.planId, 'plan-1');
  assert.equal(f.runtime.draft.partSelections?.gpu, 'gpu');
  assert.ok(
    !Object.values(f.runtime.draft.selectionSources ?? {}).includes(
      'confirmed',
    ),
  );
  assert.deepEqual(
    f.runtime.result!.plans.map((plan) => plan.parts.map((part) => part.id)),
    original,
  );
});

void test('S02 明确确认且完整兼容性通过才记录整套确认', async () => {
  const f = fixture();
  successful(
    await call(f, 'select_plan', {
      planId: 'plan-2',
      confirm: true,
      sourceMessageId: 'current',
    }),
  );
  assert.equal(f.saved[0].result?.selection?.status, 'confirmed');
  assert.equal(f.runtime.draft.partSelections?.gpu, 'gpu-upper');
  assert.equal(
    Object.values(f.runtime.draft.selectionSources ?? {}).filter(
      (source) => source === 'confirmed',
    ).length,
    8,
  );
  assert.equal(
    f.runtime.result!.plans.find((plan) => plan.id === 'plan-2')!.validation
      .status,
    'pass',
  );
});

for (const args of [
  { planId: 'other-task-plan', sourceMessageId: 'current' },
  { planId: 'plan-0', sourceMessageId: 'wrong-message' },
  { planId: 'plan-0', sourceMessageId: 'current', confirm: 'yes' },
])
  void test(`S03 非法选定请求不得修改当前状态：${JSON.stringify(args)}`, async () => {
    const f = fixture(),
      before = state(f);
    assert.equal((await call(f, 'select_plan', args)).operation.failed, true);
    assert.deepEqual(state(f), before);
    assert.equal(f.saved.length, 0);
  });

void test('S04 数据库报价已变化时拒绝确认，保留原状态供继续处理', async () => {
  const f = fixture(),
    before = state(f);
  f.catalog.parts.find((part) => part.id === 'gpu')!.price += 1;
  const result = await call(f, 'select_plan', {
    planId: 'plan-1',
    confirm: true,
    sourceMessageId: 'current',
  });
  assert.equal(result.operation.failed, true);
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('S05 多套未选定时不能猜默认第一套，应返回可选方案', async () => {
  const f = fixture(),
    before = state(f);
  const result = await call(f, 'find_replacements', { category: 'gpu' });
  assert.equal(result.operation.failed, true);
  assert.ok('observation' in result);
  assert.equal(
    (result.observation as { code: string }).code,
    'plan_choice_required',
  );
  assert.deepEqual(state(f), before);
});

void test('S06 查找替换件只验证固定其余七件的组合，不改需求或配置', async () => {
  const f = fixture(),
    before = state(f);
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
  });
  successful(result);
  assert.ok('data' in result);
  const data = result.data as {
    candidates: { productId: string; total: number }[];
    rejected: { productId: string; reason: string }[];
  };
  assert.deepEqual(
    data.candidates.map((item) => item.productId),
    ['gpu-cheaper', 'gpu-upper'],
  );
  assert.deepEqual(
    data.candidates.map((item) => item.total),
    [7950, 8050],
  );
  assert.ok(
    data.rejected.some(
      (item) =>
        item.productId === 'gpu-too-long' && item.reason.includes('显卡过长'),
    ),
  );
  assert.ok(
    data.rejected.some(
      (item) => item.productId === 'gpu-white' && item.reason.includes('颜色'),
    ),
  );
  assert.ok(data.rejected.some((item) => item.productId === 'gpu-under-limit'));
  assert.ok(data.rejected.some((item) => item.productId === 'gpu-over-limit'));
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('S07 颜色替换预览明确所需变更，不把白色配件要求改成全白', async () => {
  const f = fixture(),
    before = state(f);
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    color: '白色',
  });
  successful(result);
  assert.ok('data' in result);
  const data = result.data as {
    candidates: { productId: string }[];
    proposedPartColors: Record<string, string>;
  };
  assert.equal(data.candidates[0].productId, 'gpu-white');
  assert.deepEqual(data.proposedPartColors, { gpu: '白色' });
  assert.deepEqual(state(f), before);
});

void test('S08 空过滤结果不等于无商品，且可继续另一轮查询', async () => {
  const f = fixture();
  const empty = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    modelKeyword: '目录没有的测试型号',
  });
  successful(empty);
  assert.ok('data' in empty);
  const data = empty.data as {
    matchCount: number;
    categoryTotal: number;
    candidates: unknown[];
  };
  assert.equal(data.matchCount, 0);
  assert.ok(data.categoryTotal > 0);
  assert.equal(data.candidates.length, 0);
  successful(
    await call(f, 'find_replacements', {
      planId: 'plan-1',
      category: 'gpu',
      modelKeyword: 'gpu-cheaper',
    }),
  );
});

void test('S09 本次连续对话保留选定状态，不重传planId也可解释或查询替换件', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  successful(
    await call(f, 'select_plan', {
      planId: 'plan-1',
      sourceMessageId: 'current',
    }),
  );
  const continued = fixture();
  continued.runtime.task = structuredClone(f.saved[0]);
  continued.runtime.draft = structuredClone(f.saved[0].draft);
  continued.runtime.result = structuredClone(f.saved[0].result);
  const before = state(continued);
  successful(await call(continued, 'explain_selection', { category: 'gpu' }));
  successful(await call(continued, 'find_replacements', { category: 'gpu' }));
  assert.deepEqual(state(continued), before);
  assert.equal(continued.saved.length, 0);
});

void test('S10 替换失败后允许换候选重试，只改一件且清除旧整套确认', async () => {
  const f = fixture();
  successful(
    await call(f, 'select_plan', {
      planId: 'plan-1',
      confirm: true,
      sourceMessageId: 'current',
    }),
  );
  const before = state(f),
    count = f.saved.length;
  const rejected = await call(f, 'replace_parts', {
    sourceMessageId: 'current',
    replacements: [{ oldId: 'gpu', newId: 'gpu-too-long' }],
  });
  assert.equal(rejected.operation.failed, true);
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, count);
  successful(await call(f, 'find_replacements', { category: 'gpu' }));
  successful(
    await call(f, 'replace_parts', {
      sourceMessageId: 'current',
      replacements: [{ oldId: 'gpu', newId: 'gpu-cheaper' }],
    }),
  );
  assert.equal(
    f.runtime.result!.plans[0].parts.find((part) => part.category === 'gpu')!
      .id,
    'gpu-cheaper',
  );
  for (const part of f.runtime.result!.plans[0].parts.filter(
    (part) => part.category !== 'gpu',
  ))
    assert.equal(part.id, part.category);
  assert.notEqual(f.runtime.result!.selection?.status, 'confirmed');
});

void test('S11 整机替换预览不可拆件，返回明确限制', async () => {
  const f = fixture();
  f.runtime.result!.plans[1].kind = 'prebuilt';
  const before = state(f);
  const result = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
  });
  assert.equal(result.operation.failed, true);
  assert.ok('error' in result && result.error?.includes('整机'));
  assert.deepEqual(state(f), before);
});

void test('S12 没有配置时，选定和替换查询不能凭空生成配置', async () => {
  const f = fixture();
  f.runtime.result = null;
  const before = state(f);
  assert.equal(
    (
      await call(f, 'select_plan', {
        planId: 'plan-1',
        sourceMessageId: 'current',
      })
    ).operation.failed,
    true,
  );
  assert.equal(
    (await call(f, 'find_replacements', { category: 'gpu' })).operation.failed,
    true,
  );
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('S13 首屏候选全部不合格时仍返回下一页，不将分页当成全局无解', async () => {
  const f = fixture();
  const first = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    limit: 1,
  });
  successful(first);
  assert.ok('data' in first);
  const page = first.data as { nextOffset: number; candidates: unknown[] };
  assert.equal(page.candidates.length, 0);
  assert.equal(page.nextOffset, 1);
  const second = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    offset: page.nextOffset,
    limit: 1,
  });
  successful(second);
  assert.ok('data' in second);
  assert.equal(
    (second.data as { candidates: { productId: string }[] }).candidates[0]
      .productId,
    'gpu-cheaper',
  );
});

void test('S14 先因未选方案查询失败，选定后同样参数应能成功，不能被旧失败缓存拦住', async () => {
  const f = fixture();
  assert.equal(
    (await call(f, 'find_replacements', { category: 'gpu' })).operation.failed,
    true,
  );
  successful(
    await call(f, 'select_plan', {
      planId: 'plan-1',
      sourceMessageId: 'current',
    }),
  );
  successful(await call(f, 'find_replacements', { category: 'gpu' }));
});

void test('S15 超预算参考可以选作讨论对象，但不能记录为整套确认', async () => {
  const f = fixture();
  f.runtime.draft = completeRequirements({ ...f.runtime.draft, budget: 1 });
  const plans = recommend(
    completeRequirements(f.runtime.draft),
    f.catalog.parts,
    [],
  );
  f.runtime.result = {
    requirements: completeRequirements(f.runtime.draft),
    plans,
    summary: '参考',
  };
  const before = state(f);
  assert.equal(
    (
      await call(f, 'select_plan', {
        planId: plans[0].id,
        confirm: true,
        sourceMessageId: 'current',
      })
    ).operation.failed,
    true,
  );
  assert.deepEqual(state(f), before);
  successful(
    await call(f, 'select_plan', {
      planId: plans[0].id,
      sourceMessageId: 'current',
    }),
  );
  assert.equal(f.runtime.result!.selection?.status, 'selected');
});

void test('S16 选择保存失败时不留下半更新的当前方案', async () => {
  const f = fixture(),
    before = state(f);
  f.context.onUpdate = async () => {
    throw Error('测试：版本冲突');
  };
  const result = await call(f, 'select_plan', {
    planId: 'plan-1',
    sourceMessageId: 'current',
  });
  assert.equal(result.operation.failed, true);
  assert.ok('error' in result && result.error?.includes('版本冲突'));
  assert.deepEqual(state(f), before);
});

void test('S17 多套未选定的解释和评估同样不应默认第一套', async () => {
  for (const name of ['explain_selection', 'evaluate_plan']) {
    const f = fixture(),
      before = state(f);
    const result = await call(f, name, {});
    assert.equal(result.operation.failed, true);
    assert.ok('observation' in result);
    assert.equal(
      (result.observation as { code: string }).code,
      'plan_choice_required',
    );
    assert.deepEqual(state(f), before);
  }
});

void test('S18 单件不兼容但用户允许两件联动时，整体替换可通过且保留其余六件', async () => {
  const f = fixture();
  const preview = await call(f, 'find_replacements', {
    planId: 'plan-1',
    category: 'gpu',
    modelKeyword: 'gpu-more-power',
  });
  successful(preview);
  assert.ok('data' in preview);
  assert.equal(
    (preview.data as { candidates: unknown[] }).candidates.length,
    0,
  );
  successful(
    await call(f, 'replace_parts', {
      planId: 'plan-1',
      sourceMessageId: 'current',
      replacements: [
        { oldId: 'gpu', newId: 'gpu-more-power' },
        { oldId: 'psu', newId: 'psu-1000' },
      ],
    }),
  );
  assert.equal(f.runtime.result!.plans[0].total, 8000);
  for (const part of f.runtime.result!.plans[0].parts.filter(
    (part) => !['gpu', 'psu'].includes(part.category),
  ))
    assert.equal(part.id, part.category);
});
