import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRequirementsTool } from '../tools/requirements/update';
import { authorizeSelectionTool } from '../tools/requirements/authorize';
import { recommendPcTool } from '../tools/build/recommend';
import { assembleBuildTool } from '../tools/build/assemble';
import { evaluatePlanTool } from '../tools/build/evaluate';
import { executeRegisteredTool } from '../tools/registry';
import { completeRequirements } from '../agent/conversation-state';
import { selectPrebuilt } from '../services/recommend';
import { fixture } from './pc-fixture';

type Fixture = ReturnType<typeof fixture>;
const snapshot = (f: Fixture) => structuredClone(f.runtime);
const generators = [
  {
    name: '自动推荐',
    execute: (f: Fixture) => recommendPcTool.execute({}, f.context, f.runtime),
  },
  {
    name: '指定组装',
    execute: (f: Fixture) =>
      assembleBuildTool.execute(
        {
          productIds: f.runtime.result!.plans[1]!.parts.map((part) => part.id),
        },
        f.context,
        f.runtime,
      ),
  },
];

void test('需求保存失败时保留原预算、已选配件及旧方案', async () => {
  const f = fixture();
  f.runtime.draft.partSelections = { gpu: 'gpu' };
  f.runtime.draft.selectionSources = { gpu: 'user' };
  f.runtime.draft.selectionConfirmationMessageIds = { gpu: 'previous-message' };
  const before = snapshot(f);
  let attempts = 0;
  f.context.onUpdate = async (type, draft, result) => {
    attempts++;
    assert.equal(type, 'requirements');
    assert.equal(draft.budget, 9000);
    assert.equal(draft.partSelections, undefined);
    assert.equal(result, null);
    assert.deepEqual(snapshot(f), before);
    throw Error('注入需求保存失败');
  };
  await assert.rejects(
    updateRequirementsTool.execute({ budget: 9000 }, f.context, f.runtime),
    /注入需求保存失败/,
  );
  assert.equal(attempts, 1);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(snapshot(f), before);
});

void test('选择授权保存失败时不增加授权、不清除已选配件和旧方案', async () => {
  const f = fixture();
  f.context.messages[0]!.content = '显卡在现有预算和颜色约束内由你选择';
  f.runtime.draft.partSelections = { gpu: 'gpu' };
  const before = snapshot(f);
  let attempts = 0;
  f.context.onUpdate = async (type, draft, result) => {
    attempts++;
    assert.equal(type, 'requirements');
    assert.equal(draft.selectionAuthorizations?.gpu, '现有预算和颜色约束');
    assert.equal(draft.selectionAuthorizationMessageIds?.gpu, 'current');
    assert.equal(draft.partSelections, undefined);
    assert.equal(result, null);
    throw Error('注入选择授权保存失败');
  };
  await assert.rejects(
    authorizeSelectionTool.execute(
      {
        category: 'gpu',
        scopeType: 'current_constraints',
        scope: '现有预算和颜色约束',
        sourceMessageId: 'current',
      },
      f.context,
      f.runtime,
    ),
    /注入选择授权保存失败/,
  );
  assert.equal(attempts, 1);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(snapshot(f), before);
});

void test('评估保存失败保留旧结果和待评估标记，重试保存成功才更新', async () => {
  const f = fixture();
  f.context.embeddingConfig = {};
  f.runtime.pendingEvaluation = { planIds: ['plan-0', 'plan-1', 'plan-2'] };
  const before = snapshot(f);
  const persist = f.context.onUpdate!;
  let attempts = 0;
  f.context.onUpdate = async (type, draft, result) => {
    attempts++;
    assert.equal(type, 'evaluation');
    assert.equal(result?.evaluation?.planId, 'plan-1');
    assert.equal(result?.evaluation?.knowledgeStatus, 'unavailable');
    assert.deepEqual(draft, before.draft);
    throw Error('注入评估保存失败');
  };
  await assert.rejects(
    evaluatePlanTool.execute({ planId: 'plan-1' }, f.context, f.runtime),
    /注入评估保存失败/,
  );
  assert.equal(attempts, 1);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(snapshot(f), { ...before, readOnlyEvaluationTurn: true });
  f.context.onUpdate = persist;
  await evaluatePlanTool.execute({ planId: 'plan-1' }, f.context, f.runtime);
  assert.equal(f.saved.length, 1);
  assert.deepEqual(f.runtime.result, f.saved[0]!.result);
  assert.equal(f.runtime.result?.evaluation?.planId, 'plan-1');
  assert.equal(f.runtime.pendingEvaluation, undefined);
  assert.equal(f.runtime.knowledgeUnavailable, true);
  assert.equal(f.runtime.readOnlyEvaluationTurn, true);
  assert.deepEqual(f.runtime.toolsUsed, ['评估方案']);
});

void test('评估发现本轮目录变化或当前需求冲突时返回具体问题并保留原方案', async () => {
  const scenarios: {
    update: (f: Fixture, catalog: Fixture['catalog']) => void;
    issue: RegExp;
  }[] = [
    {
      update: (_f, catalog) => {
        catalog.parts = catalog.parts.filter((part) => part.id !== 'cpu');
      },
      issue: /八类完整/,
    },
    {
      update: (_f, catalog) => {
        catalog.parts.find((part) => part.id === 'gpu')!.price += 10;
      },
      issue: /报价已变化/,
    },
    {
      update: (_f, catalog) => {
        catalog.parts.find((part) => part.id === 'gpu')!.specs.length = 450;
      },
      issue: /显卡过长/,
    },
    {
      update: (f) => {
        f.runtime.draft.budget = 7990;
        f.runtime.draft.hardCap = true;
      },
      issue: /预算/,
    },
  ];
  for (const { update, issue } of scenarios) {
    const f = fixture();
    f.context.embeddingConfig = {};
    f.runtime.result!.selection = {
      planId: 'plan-1',
      status: 'confirmed',
      source: 'ui',
    };
    f.runtime.result!.evaluation = {
      planId: 'plan-1',
      issues: [],
      directions: ['上次评估'],
      suggestions: [],
      createdAt: 1,
    };
    const currentCatalog = structuredClone(f.catalog);
    update(f, currentCatalog);
    f.context.reloadCatalog = async () => currentCatalog;
    const before = snapshot(f);
    const output = await executeRegisteredTool(
      'evaluate_plan',
      { planId: 'plan-1' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true);
    assert.match(output.operation.error ?? '', issue);
    assert.deepEqual(f.runtime.draft, before.draft);
    assert.deepEqual(f.runtime.result, before.result);
    assert.equal(f.saved.length, 0);
  }
});

void test('评估使用重载规格和当前预算型号约束，成功时仅保存评估', async () => {
  const f = fixture();
  f.context.embeddingConfig = {};
  f.runtime.draft.budgetTolerance = 20;
  f.runtime.draft.partPreferences = { gpu: 'gpu' };
  const currentCatalog = structuredClone(f.catalog);
  currentCatalog.parts.find(
    (part) => part.id === 'motherboard',
  )!.specs.biosVerified = false;
  f.context.reloadCatalog = async () => currentCatalog;
  const before = snapshot(f);
  await evaluatePlanTool.execute(
    { planId: 'plan-1', candidateProductId: 'gpu-cheaper' },
    f.context,
    f.runtime,
  );
  const evaluation = f.runtime.result!.evaluation!;
  assert.ok(evaluation.issues.some((issue) => issue.includes('BIOS')));
  assert.ok(
    evaluation.directions.some((direction) => direction.includes('¥20')),
  );
  assert.equal(evaluation.suggestions[0]!.valid, false);
  assert.match(evaluation.suggestions[0]!.reason ?? '', /指定型号/);
  assert.deepEqual(f.runtime.draft, before.draft);
  assert.deepEqual(f.runtime.result, { ...before.result, evaluation });
  assert.equal(f.saved.length, 1);
});

void test('整机评估复用整机审核，仍不执行DIY兼容性检查或替换配件', async () => {
  const f = fixture();
  f.context.embeddingConfig = {};
  const requirements = completeRequirements({
    ...f.runtime.draft,
    mode: 'prebuilt',
  });
  f.runtime.draft = requirements;
  const pc = {
    id: 'prebuilt-evaluation',
    name: '测试整机',
    brand: '测试品牌',
    color: '黑色',
    price: 8000,
    demo: true,
    partIds: f.catalog.parts
      .filter((part) => part.id === part.category)
      .map((part) => part.id),
  };
  f.catalog.prebuilts = [pc];
  const plan = selectPrebuilt(
    pc.id,
    requirements,
    f.catalog.parts,
    f.catalog.prebuilts,
  );
  f.runtime.result = { requirements, plans: [plan], summary: '测试整机' };
  const currentCatalog = structuredClone(f.catalog);
  currentCatalog.parts.find((part) => part.id === 'gpu')!.specs.length = 450;
  f.context.reloadCatalog = async () => currentCatalog;
  const before = snapshot(f);
  await evaluatePlanTool.execute({}, f.context, f.runtime);
  assert.deepEqual(f.runtime.result!.evaluation!.issues, []);
  assert.deepEqual(f.runtime.result!.evaluation!.suggestions, []);
  assert.deepEqual(f.runtime.result!.plans, before.result!.plans);
  assert.deepEqual(f.runtime.draft, before.draft);
});

void test('两条配置路径在配件保存失败时均保留原运行态', async () => {
  for (const generator of generators) {
    const f = fixture();
    const before = snapshot(f);
    const attempts: string[] = [];
    f.context.onUpdate = async (type, draft, result) => {
      attempts.push(type);
      assert.equal(type, 'parts', generator.name);
      assert.equal(Object.keys(draft.partSelections ?? {}).length, 8);
      assert.equal(result, null);
      assert.deepEqual(snapshot(f), before, generator.name);
      throw Error('注入配件保存失败');
    };
    await assert.rejects(generator.execute(f), /注入配件保存失败/);
    assert.deepEqual(attempts, ['parts']);
    assert.equal(f.saved.length, 0);
    assert.deepEqual(snapshot(f), before, generator.name);
  }
});

for (const generator of generators) {
  void test(`${generator.name}最终保存失败时仅保留已保存配件，不产生未保存方案`, async () => {
    const f = fixture();
    const previousTask = structuredClone(f.runtime.task);
    const persist = f.context.onUpdate!;
    const attempts: string[] = [];
    f.context.onUpdate = async (type, draft, result) => {
      attempts.push(type);
      if (type === 'parts') return persist(type, draft, result);
      assert.equal(type, 'plan');
      assert.ok(result?.plans.length);
      assert.ok(result.plans.every((plan) => plan.parts.length === 8));
      assert.equal(f.saved.length, 1);
      assert.deepEqual(f.runtime.draft, f.saved[0]!.draft);
      assert.equal(f.runtime.result, null);
      throw Error('注入最终方案保存失败');
    };
    await assert.rejects(generator.execute(f), /注入最终方案保存失败/);
    assert.deepEqual(attempts, ['parts', 'plan']);
    assert.equal(f.saved.length, 1);
    assert.equal(Object.keys(f.saved[0]!.draft.partSelections ?? {}).length, 8);
    assert.equal(f.saved[0]!.result, null);
    assert.deepEqual(f.runtime.draft, f.saved[0]!.draft);
    assert.equal(f.runtime.result, null);
    assert.deepEqual(f.runtime.toolsUsed, []);
    assert.deepEqual(f.runtime.task, previousTask);
  });
}
