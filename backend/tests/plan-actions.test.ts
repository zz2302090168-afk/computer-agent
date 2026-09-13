import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPlanActionTask, planActionResponse } from '../api/plan-actions';
import { searchCatalogTool } from '../tools/catalog/search';
import { fixture } from './pc-fixture';

void test('页面选择、替换与导出必须引用当前任务和用户看到的版本', () => {
  const task = { id: 'task', version: 4 };
  assert.doesNotThrow(() =>
    assertPlanActionTask({ taskId: 'task', expectedVersion: 4 }, task),
  );
  for (const taskId of [undefined, 'other-task', ''])
    assert.throws(
      () => assertPlanActionTask({ taskId, expectedVersion: 4 }, task),
      /任务已切换/,
    );
  for (const expectedVersion of [undefined, null, '4', 0, -1, 1.5, Infinity])
    assert.throws(
      () => assertPlanActionTask({ taskId: 'task', expectedVersion }, task),
      /有效的任务版本/,
    );
  for (const expectedVersion of [3, 5])
    assert.throws(
      () => assertPlanActionTask({ taskId: 'task', expectedVersion }, task),
      /配置已更新/,
    );
});

void test('页面操作响应带回保存后的草稿和版本，不复活旧确认信息', () => {
  const { runtime } = fixture();
  const task = {
    ...runtime.task,
    version: 5,
    updatedAt: 12345,
    draft: {
      ...runtime.draft,
      support: { status: 'active' as const, symptom: '黑屏', history: [] },
    },
    result: { ...runtime.result!, selection: undefined, evaluation: undefined },
  };
  const data = JSON.parse(JSON.stringify(planActionResponse(task)));
  assert.equal(data.taskId, task.id);
  assert.equal(data.version, 5);
  assert.equal(data.updatedAt, 12345);
  assert.deepEqual(data.draft, task.draft);
  assert.equal(data.selection, undefined);
  assert.equal(data.evaluation, undefined);
  assert.deepEqual(data.plans, task.result.plans);
});

void test('商品查询给模型保留真实与演示身份，不能仅根据型号名称推断', async () => {
  const { runtime, context, catalog } = fixture();
  const cpu = catalog.parts.find((part) => part.category === 'cpu')!;
  catalog.parts.push({ ...cpu, id: 'cpu-real', demo: false });
  const output = await searchCatalogTool.execute(
    { category: 'cpu' },
    context,
    runtime,
  );
  assert.ok(output && typeof output === 'object' && 'matches' in output);
  const matches = output.matches as { id: string; demo: boolean }[];
  assert.equal(matches.find((part) => part.id === cpu.id)?.demo, true);
  assert.equal(matches.find((part) => part.id === 'cpu-real')?.demo, false);
});
