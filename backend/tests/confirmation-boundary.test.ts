import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutionError } from '../domain/errors';
import { confirmSelectionsTool } from '../tools/requirements/confirm';
import { selectPlanTool } from '../tools/build/select';
import { executeRegisteredTool } from '../tools/registry';
import { categories } from '../tools/types';
import { completeRequirements } from '../agent/conversation-state';
import { recommend } from '../services/recommend';
import { fixture } from './pc-fixture';

function confirmationFixture() {
  const f = fixture();
  const first = f.runtime.result!.plans[0]!;
  f.runtime.draft = {
    ...f.runtime.draft,
    partSelections: Object.fromEntries(
      first.parts.map((part) => [part.category, part.id]),
    ),
    selectionSources: Object.fromEntries(
      first.parts.map((part) => [part.category, 'assistant' as const]),
    ),
  };
  return f;
}

type Fixture = ReturnType<typeof confirmationFixture>;
const confirmation = { categories: ['gpu'], sourceMessageId: 'current' };
const state = (f: Fixture) =>
  structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
    task: f.runtime.task,
    toolsUsed: f.runtime.toolsUsed,
  });

void test('局部确认拒绝多套未选定，不能默认确认第一套草稿配件', async () => {
  const f = confirmationFixture();
  const before = state(f);
  await assert.rejects(
    confirmSelectionsTool.execute(confirmation, f.context, f.runtime),
    (cause: unknown) => {
      assert.ok(cause instanceof ToolExecutionError);
      assert.deepEqual(cause.observation, {
        code: 'plan_choice_required',
        choices: f.runtime.result!.plans.map((plan) => ({
          planId: plan.id,
          name: plan.tier ?? plan.name,
          total: plan.total,
        })),
      });
      return true;
    },
  );
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
  const result = await executeRegisteredTool(
    'confirm_selections',
    confirmation,
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('选定第二套后只确认该方案显卡，不确认整套及其他类别', async () => {
  const f = confirmationFixture();
  await selectPlanTool.execute(
    { planId: 'plan-1', sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  const selection = structuredClone(f.runtime.result!.selection);
  await confirmSelectionsTool.execute(confirmation, f.context, f.runtime);
  assert.equal(f.runtime.draft.partSelections?.gpu, 'gpu');
  assert.equal(f.runtime.draft.selectionSources?.gpu, 'confirmed');
  assert.equal(f.runtime.draft.selectionSources?.cpu, 'assistant');
  assert.equal(f.runtime.draft.selectionConfirmationMessageIds?.gpu, 'current');
  assert.deepEqual(f.runtime.result!.selection, selection);
  assert.equal(f.runtime.result!.requirements.partSelections?.gpu, 'gpu');
  assert.equal(
    f.runtime.result!.requirements.selectionSources?.gpu,
    'confirmed',
  );
  assert.deepEqual(f.saved.at(-1)!.draft, f.runtime.draft);
  assert.deepEqual(f.runtime.task.result, f.runtime.result);
  assert.equal(f.runtime.task.version, f.saved.at(-1)!.version);
});

void test('唯一方案从实际商品确认，不沿用旧草稿第一套的显卡', async () => {
  const f = confirmationFixture();
  f.runtime.result!.plans = [f.runtime.result!.plans[1]!];
  assert.equal(f.runtime.draft.partSelections?.gpu, 'gpu-cheaper');
  await confirmSelectionsTool.execute(confirmation, f.context, f.runtime);
  assert.equal(f.runtime.draft.partSelections?.gpu, 'gpu');
  assert.equal(f.runtime.draft.selectionSources?.gpu, 'confirmed');
  assert.equal(f.runtime.result!.selection, undefined);
});

void test('局部确认保留已存在的整套确认状态', async () => {
  const f = confirmationFixture();
  await selectPlanTool.execute(
    { planId: 'plan-1', sourceMessageId: 'current', confirm: true },
    f.context,
    f.runtime,
  );
  const selection = structuredClone(f.runtime.result!.selection);
  await confirmSelectionsTool.execute(confirmation, f.context, f.runtime);
  assert.deepEqual(f.runtime.result!.selection, selection);
  assert.equal(f.runtime.result!.selection?.status, 'confirmed');
});

void test('局部确认只审核目标方案，其他候选失效不阻断已选商品', async () => {
  const f = confirmationFixture();
  await selectPlanTool.execute(
    { planId: 'plan-1', sourceMessageId: 'current' },
    f.context,
    f.runtime,
  );
  f.runtime.result!.plans[0]!.parts = [];
  await confirmSelectionsTool.execute(confirmation, f.context, f.runtime);
  assert.equal(f.runtime.draft.selectionSources?.gpu, 'confirmed');
});

void test('局部确认保存失败时草稿、方案和任务均保持原状态', async () => {
  const f = confirmationFixture();
  f.runtime.result!.plans = [f.runtime.result!.plans[1]!];
  const before = state(f);
  f.context.onUpdate = async () => {
    throw Error('保存失败');
  };
  await assert.rejects(
    confirmSelectionsTool.execute(confirmation, f.context, f.runtime),
    /保存失败/,
  );
  assert.deepEqual(state(f), before);
  const result = await executeRegisteredTool(
    'confirm_selections',
    confirmation,
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.deepEqual(state(f), before);
});

void test('局部确认的审核失败不能经注册表清空旧方案或写确认', async () => {
  const f = confirmationFixture();
  f.runtime.result!.plans = [f.runtime.result!.plans[1]!];
  f.catalog.parts.find((part) => part.id === 'gpu')!.price += 1;
  const before = state(f);
  const result = await executeRegisteredTool(
    'confirm_selections',
    confirmation,
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.ok('error' in result);
  assert.match(result.error ?? '', /报价已变化/);
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('低预算八类参考仍禁止局部确认', async () => {
  const f = confirmationFixture();
  f.runtime.draft.budget = 1;
  const requirements = completeRequirements(f.runtime.draft);
  f.runtime.result = {
    requirements,
    plans: recommend(requirements, f.catalog.parts, f.catalog.prebuilts),
    summary: '超预算参考',
  };
  assert.equal(f.runtime.result.plans.length, 1);
  const before = state(f);
  await assert.rejects(
    confirmSelectionsTool.execute(confirmation, f.context, f.runtime),
    /超预算参考/,
  );
  assert.deepEqual(state(f), before);
  assert.equal(f.saved.length, 0);
});

void test('局部确认拒绝旧用户消息、其他任务消息及整套八类确认', async () => {
  const f = confirmationFixture();
  f.context.messages.push(
    { id: 'old', role: 'user', taskId: 'task', content: '之前的确认' },
    { id: 'foreign', role: 'user', taskId: 'other', content: '别的任务' },
  );
  const before = state(f);
  for (const [input, message] of [
    [{ ...confirmation, sourceMessageId: 'old' }, /当前用户消息/],
    [{ ...confirmation, sourceMessageId: 'foreign' }, /不属于当前任务/],
    [{ ...confirmation, categories: [...categories] }, /select_plan/],
  ] as const) {
    await assert.rejects(
      confirmSelectionsTool.execute(input, f.context, f.runtime),
      message,
    );
    assert.deepEqual(state(f), before);
  }
  assert.equal(f.saved.length, 0);
});
