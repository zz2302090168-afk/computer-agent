import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import mysql from 'mysql2/promise';
import { monitors } from '../../data/seed/monitors';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import { availableTools } from '../agent/conversation';
import { sanitizeRecommendationResult } from '../domain/sanitize';
import { planActionResponse } from '../api/plan-actions';
import { applyPlanActionResponse } from '../../frontend/result-state';
import {
  recommendMonitors,
  validateMonitorCriteria,
} from '../services/recommend-monitors';

void test('显示器目录包含50条非演示记录，覆盖规格范围（不替代厂家核验）', () => {
  assert.equal(monitors.length, 50);
  assert.equal(new Set(monitors.map((monitor) => monitor.id)).size, 50);
  assert.ok(monitors.every((monitor) => !monitor.demo));
  assert.equal(Math.min(...monitors.map((monitor) => monitor.price)), 200);
  assert.equal(Math.max(...monitors.map((monitor) => monitor.price)), 5000);
  assert.deepEqual(
    new Set(monitors.map((monitor) => monitor.specs.resolution)),
    new Set(['1080p', '1440p', '4K']),
  );
  assert.ok(monitors.some((monitor) => monitor.specs.panel === 'OLED'));
  assert.ok(monitors.some((monitor) => monitor.specs.panel === 'MiniLED'));
  assert.equal(
    Math.min(...monitors.map((monitor) => monitor.specs.refreshRate)),
    60,
  );
  assert.equal(
    Math.max(...monitors.map((monitor) => monitor.specs.refreshRate)),
    320,
  );
});

void test('显示器推荐只返回目录真实型号，并执行筛选边界', () => {
  const result = recommendMonitors(
    {
      budget: 5000,
      resolution: '4K',
      panel: 'OLED',
      minRefreshRate: 240,
      purpose: '游戏',
    },
    { monitors },
  );
  assert.equal(result.total, 1);
  assert.equal(result.catalogTotal, 50);
  assert.equal(result.monitors[0]?.id, 'monitor-50');
  assert.ok(result.monitors.every((monitor) => !monitor.demo));
  assert.equal(recommendMonitors({ budget: 200 }, { monitors }).total, 1);
  assert.equal(
    recommendMonitors({ budget: 5000, minRefreshRate: 320 }, { monitors })
      .total,
    3,
  );
});

void test('更正型号规格后不再误入4K或180Hz筛选，没有来源不标记已核验', () => {
  const xiaomi = monitors.find((item) => item.id === 'monitor-48')!;
  const gigabyte = monitors.find((item) => item.id === 'monitor-22')!;
  assert.equal(xiaomi.specs.resolution, '1440p');
  assert.equal(xiaomi.specs.refreshRate, 180);
  assert.equal(gigabyte.specs.refreshRate, 170);
  assert.match(gigabyte.specs.refreshRateNote!, /原生165Hz/);
  assert.ok(
    monitors.every((item) => !item.specs.checkedAt || item.specs.source),
  );
  assert.ok(
    !recommendMonitors(
      { resolution: '4K', panel: 'MiniLED' },
      { monitors },
    ).monitors.some((item) => item.id === xiaomi.id),
  );
  assert.ok(
    !recommendMonitors({ minRefreshRate: 180 }, { monitors: [gigabyte] }).total,
  );
  assert.equal(recommendMonitors({}, { monitors: [xiaomi] }).catalogTotal, 1);
});

function monitorDatabase(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'mysqlPool');
  const pool = mysql.createPool('mysql://test:test@127.0.0.1:3306/test');
  Object.defineProperty(globalThis, 'mysqlPool', {
    value: pool,
    configurable: true,
    writable: true,
  });
  t.after(async () => {
    if (previous) Object.defineProperty(globalThis, 'mysqlPool', previous);
    else Reflect.deleteProperty(globalThis, 'mysqlPool');
    await pool.end();
  });
  return t.mock.method(pool, 'execute', async (sql: string) => {
    if (sql.startsWith('SELECT value FROM metadata'))
      return [[{ value: 'initialized' }], []];
    if (sql.startsWith('SELECT * FROM monitors'))
      return [
        monitors.map((item) => ({
          ...item,
          specs: JSON.stringify(item.specs),
          demo: Number(item.demo),
        })),
        [],
      ];
    throw Error(`未预期的数据库访问：${sql}`);
  });
}

void test('显示器工具保存并恢复右侧结果，但不改主机、需求或确认状态', async (t) => {
  monitorDatabase(t);
  const f = fixture();
  f.runtime.requestAction = 'recommend_monitor';
  const before = structuredClone(f.runtime.result!);
  const draft = structuredClone(f.runtime.draft);
  const output = await executeRegisteredTool(
    'recommend_monitor',
    { budget: 3500, resolution: '4K', panel: 'MiniLED' },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  assert.equal(f.saved.length, 1);
  const saved = f.saved[0];
  const restored = sanitizeRecommendationResult(
    JSON.parse(JSON.stringify(saved.result)),
  );
  assert.deepEqual(
    restored.monitorRecommendation,
    f.runtime.result!.monitorRecommendation,
  );
  assert.deepEqual(restored.plans, before.plans);
  assert.deepEqual(restored.selection, before.selection);
  assert.deepEqual(f.runtime.draft, draft);
  const next = applyPlanActionResponse(
    {
      draft,
      result: before,
      task: f.runtime.task,
      currentTaskId: 'task',
      messages: [],
    },
    planActionResponse(saved),
  );
  assert.deepEqual(
    next.result?.monitorRecommendation,
    restored.monitorRecommendation,
  );
  assert.equal(next.task?.version, saved.version);
});

void test('显示器重复失败只反馈外设错误，不进入主机探索，也不丢失原方案', async () => {
  for (const action of ['recommend_monitor', 'other', 'recommend'] as const) {
    const f = fixture();
    f.runtime.requestAction = action;
    // 模拟本轮主机需求已经保存、配置已经完成，再继续选择外设。
    f.runtime.requirementsTaskId = f.runtime.task.id;
    f.runtime.exploration = { status: 'ready', reason: '主机已完成' };
    const before = JSON.stringify(f.runtime.result);
    for (let i = 0; i < 2; i++) {
      const output = await executeRegisteredTool(
        'recommend_monitor',
        { budget: 199 },
        f.context,
        f.runtime,
      );
      assert.equal(output.operation.failed, true);
      assert.equal(f.runtime.exploration.status, 'ready');
    }
    assert.equal(JSON.stringify(f.runtime.result), before);
    assert.equal(f.saved.length, 0);
    const names = availableTools(f.runtime, 1).map(
      (tool) => tool.function.name,
    );
    assert.equal(names.includes('recommend_monitor'), action !== 'other');
    if (action !== 'recommend') assert.ok(!names.includes('recommend_pc'));
  }
});

void test('缺少显示器表与保存失败均不改当前任务，评估轮不能保存外设推荐', async (t) => {
  const query = monitorDatabase(t);
  const f = fixture();
  f.runtime.requestAction = 'recommend_monitor';
  const before = JSON.stringify(f.runtime.result);
  query.mock.mockImplementationOnce(async () => {
    throw Object.assign(Error('missing table'), { code: 'ER_NO_SUCH_TABLE' });
  });
  const missing = await executeRegisteredTool(
    'recommend_monitor',
    {},
    f.context,
    f.runtime,
  );
  assert.match(String(missing.error), /数据库尚未初始化/);
  assert.equal(f.runtime.exploration, undefined);
  f.context.onUpdate = async () => {
    throw Error('任务已被其他请求更新');
  };
  const failedSave = await executeRegisteredTool(
    'recommend_monitor',
    { budget: 3000 },
    f.context,
    f.runtime,
  );
  assert.match(String(failedSave.error), /任务已被其他请求更新/);
  assert.equal(JSON.stringify(f.runtime.result), before);
  f.runtime.readOnlyEvaluationTurn = true;
  const readOnly = await executeRegisteredTool(
    'recommend_monitor',
    { budget: 2000 },
    f.context,
    f.runtime,
  );
  assert.equal(readOnly.operation.failed, true);
  assert.equal(JSON.stringify(f.runtime.result), before);
  f.runtime.readOnlyEvaluationTurn = false;
  f.runtime.result = null;
  const noHost = await executeRegisteredTool(
    'recommend_monitor',
    { budget: 2000 },
    f.context,
    f.runtime,
  );
  assert.match(String(noHost.error), /先完成主机配置/);
});

void test('显示器筛选拒绝越界或未知参数', () => {
  assert.throws(() => validateMonitorCriteria({ budget: 199 }), /200 到 5000/);
  assert.throws(
    () => validateMonitorCriteria({ minRefreshRate: 321 }),
    /60 到 320Hz/,
  );
  assert.throws(() => validateMonitorCriteria({ demo: true }), /未知字段/);
});
