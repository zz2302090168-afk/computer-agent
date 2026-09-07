import test from 'node:test';
import assert from 'node:assert/strict';
import { withinBudget, budgetRange } from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import { parseRequirements } from '../agent/requirements';
import { assembleBuild, recommend, replacePart } from '../services/recommend';
import { searchCatalog } from '../services/catalog-search';
import { parts, prebuilts } from '../../data/seed/catalog';
import { retrieveKnowledge } from '../rag/retrieve';
import {
  applyDraft,
  changesRecommendation,
  completeRequirements,
  inferExplicitPatch,
} from '../agent/conversation-state';
import {
  createToolRegistry,
  executeRegisteredTool,
  registeredTools,
} from '../tools/registry';
import type { RegisteredTool, ToolRuntime } from '../tools/types';
import { stripLegacyFps } from '../domain/sanitize';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
const req = parseRequirements({
  budget: 6000,
  purpose: '游戏',
  mode: 'both',
  color: '不限',
});
void test('预算严格覆盖正负1000边界与明确上限', () => {
  assert.ok(withinBudget(5000, 6000));
  assert.ok(withinBudget(7000, 6000));
  assert.ok(!withinBudget(4999.99, 6000));
  assert.ok(!withinBudget(7000.01, 6000));
  assert.ok(!withinBudget(6000.01, 6000, true));
  for (const x of [NaN, Infinity, -1, 0]) assert.throws(() => budgetRange(x));
});
void test('160个SKU，无库存数量或在售字段', () => {
  assert.equal(parts.length, 160);
  for (const c of new Set(parts.map((p) => p.category)))
    assert.equal(parts.filter((p) => p.category === c).length, 20);
  for (const p of parts) {
    assert.ok(!('stock' in p));
    assert.ok(!('status' in p));
    assert.match(String(p.specs.source), /^https:\/\//);
    assert.equal(p.demo, false);
  }
  const whiteMsi5070 = parts.find(
    (p) =>
      p.brand === 'MSI 微星' &&
      p.name === 'GeForce RTX 5070 12G VENTUS 2X OC WHITE',
  );
  assert.deepEqual(
    { color: whiteMsi5070?.color, price: whiteMsi5070?.price },
    { color: '白色', price: 7000 },
  );
});
void test('全部商家整机无已知规格冲突，未知项明确保留', () => {
  assert.equal(prebuilts.length, 20);
  for (const pc of prebuilts) {
    const ps = pc.partIds.map((id) => parts.find((p) => p.id === id)!);
    assert.equal(pc.partIds.length, 8, pc.id);
    assert.equal(new Set(ps.map((p) => p.category)).size, 8, pc.id);
    assert.ok(ps.every(Boolean), pc.id);
    assert.notEqual(validateBuild(ps).status, 'fail', pc.id);
  }
});
void test('接口、尺寸、缺失规格和重复类别不能被当成兼容', () => {
  const ps = prebuilts[0].partIds.map((id) =>
    structuredClone(parts.find((p) => p.id === id)!),
  );
  ps.find((p) => p.category === 'memory')!.specs.ddr = 'DDR5';
  assert.equal(validateBuild(ps).status, 'fail');
  ps.find((p) => p.category === 'memory')!.specs.ddr = 'DDR4';
  delete ps.find((p) => p.category === 'gpu')!.specs.length;
  assert.equal(validateBuild(ps).status, 'unknown');
  assert.equal(validateBuild([...ps, ps[0]]).status, 'fail');
});
void test('所有预算用途返回的配置均满足硬约束', () => {
  let count = 0;
  for (const budget of [3000, 6000, 10000, 18000, 30000])
    for (const purpose of ['游戏', '办公', '编程', '本地 AI']) {
      const r = { ...req, budget, purpose };
      for (const p of recommend(r, parts, prebuilts)) {
        count++;
        assert.ok(withinBudget(p.total, budget));
        assert.equal(p.parts.length, 8);
        assert.notEqual(validateBuild(p.parts).status, 'fail');
      }
    }
  assert.ok(count > 20);
});
void test('不可能预算返回空，不强行凑方案', () =>
  assert.deepEqual(
    recommend({ ...req, budget: 1, hardCap: true }, parts, prebuilts),
    [],
  ));
void test('硬上限、白色与整机模式生效', () => {
  const r = parseRequirements({ ...req, message: '最多6000元，白色整机' });
  assert.ok(r.hardCap);
  for (const p of recommend(r, parts, prebuilts)) {
    assert.equal(p.kind, 'prebuilt');
    assert.ok(p.total <= 6000);
    assert.equal(p.parts.find((x) => x.category === 'case')?.color, '白色');
  }
});
void test('替换不能注入未知商品或跨类别商品', () => {
  const p = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0];
  assert.ok(p);
  assert.throws(() => replacePart(p, p.parts[0].id, 'missing', req, parts));
  assert.throws(() => replacePart(p, p.parts[0].id, 'case-0', req, parts));
});
void test('分类品牌偏好同时约束 DIY、整机与替换', () => {
  const branded = { ...req, brandPreferences: { gpu: 'MSI 微星' } };
  for (const plan of recommend(branded, parts, prebuilts))
    assert.equal(
      plan.parts.find((p) => p.category === 'gpu')?.brand,
      'MSI 微星',
    );
  const diy = recommend({ ...branded, mode: 'diy' }, parts, prebuilts)[0];
  assert.ok(diy);
  const oldGpu = diy.parts.find((p) => p.category === 'gpu')!;
  const foreign = { ...oldGpu, id: 'foreign-gpu', brand: '其他品牌' };
  assert.throws(
    () => replacePart(diy, oldGpu.id, foreign.id, branded, [...parts, foreign]),
    /品牌偏好/,
  );
});
void test('需求变化使旧方案失效，便宜一点保留原预算', () => {
  const before = {
    budget: 6000,
    purpose: '游戏',
    mode: 'both' as const,
    color: '不限',
    preferCheaper: false,
  };
  const cheaper = applyDraft(before, { preferCheaper: true });
  assert.equal(cheaper.budget, 6000);
  assert.equal(completeRequirements(cheaper).budget, 6000);
  assert.ok(changesRecommendation(before, cheaper));
  assert.ok(
    changesRecommendation(cheaper, applyDraft(cheaper, { color: '白色' })),
  );
  assert.ok(
    changesRecommendation(cheaper, applyDraft(cheaper, { mode: 'diy' })),
  );
  assert.ok(
    changesRecommendation(
      cheaper,
      applyDraft(cheaper, { brandPreferences: { gpu: 'MSI' } }),
    ),
  );
  const plans = recommend(completeRequirements(cheaper), parts, prebuilts);
  for (const plan of plans) assert.ok(withinBudget(plan.total, 6000));
  assert.deepEqual(
    plans.map((p) => p.total),
    [...plans].sort((a, b) => a.total - b.total).map((p) => p.total),
  );
});
void test('明确预算上限和购买方式由服务端确定性提取', () => {
  const changed = applyDraft(
    { budget: 6000, purpose: '游戏', hardCap: false },
    inferExplicitPatch('改成最多8000元，只看白色整机'),
  );
  assert.equal(changed.budget, 8000);
  assert.equal(changed.hardCap, true);
  assert.equal(changed.color, '白色');
  assert.equal(changed.mode, 'prebuilt');
  const cheaper = applyDraft(changed, inferExplicitPatch('便宜一点'));
  assert.equal(cheaper.budget, 8000);
  assert.equal(cheaper.hardCap, true);
  assert.equal(cheaper.preferCheaper, true);
});
void test('系列授权有局部作用域，5070 不包含 5070 Ti', () => {
  const draft = applyDraft(
    {},
    inferExplicitPatch('6000元游戏主机，5070你自己选'),
  );
  assert.equal(draft.budget, 6000);
  assert.equal(draft.purpose, '游戏');
  assert.equal(draft.seriesPreferences?.gpu, 'RTX 5070');
  assert.equal(draft.selectionAuthorizations?.gpu, 'RTX 5070');
  const plans = recommend(completeRequirements(draft), parts, prebuilts);
  assert.ok(plans.length);
  for (const plan of plans) {
    const gpu = plan.parts.find((p) => p.category === 'gpu')!;
    assert.match(gpu.name, /RTX 5070/i);
    assert.doesNotMatch(gpu.name, /5070\s*Ti/i);
    assert.ok(withinBudget(plan.total, 6000));
  }
  const colorOnly = applyDraft(draft, inferExplicitPatch('颜色随便'));
  assert.equal(colorOnly.color, '不限');
  assert.equal(colorOnly.budget, 6000);
  assert.equal(colorOnly.seriesPreferences?.gpu, 'RTX 5070');
  assert.deepEqual(
    recommend(
      completeRequirements({ ...draft, budget: 3000, hardCap: true }),
      parts,
      prebuilts,
    ),
    [],
  );
});
void test('数据库升级清除旧演示目录与历史推荐，保留商家维护商品', () => {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '0000_secret_agent_zero.sql',
    '0001_kind_chameleon.sql',
    '0002_breezy_ben_parker.sql',
  ])
    for (const statement of readFileSync(
      new URL(`../../drizzle/${file}`, import.meta.url),
      'utf8',
    ).split('--> statement-breakpoint'))
      if (statement.trim()) db.exec(statement);
  db.exec(
    `INSERT INTO products VALUES ('cpu-0','cpu','星构 DEMO','旧演示','不适用',1,'{}',1),('merchant-cpu','cpu','商家品牌','自行维护','不适用',2,'{}',1);`,
  );
  db.exec(
    `INSERT INTO prebuilts VALUES ('pc-0','旧整机','星构 DEMO','黑色',1,'[]',1);`,
  );
  db.exec(
    `INSERT INTO sessions VALUES ('legacy','{}','[{"id":"pc-0","demo":true}]',1),('current','{}','[]',1);`,
  );
  db.exec(
    `INSERT INTO conversations VALUES ('legacy','{}','[]',1),('current','{}','[]',1);`,
  );
  for (const statement of readFileSync(
    new URL(
      '../../drizzle/0003_remove_legacy_demo_recommendations.sql',
      import.meta.url,
    ),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) db.exec(statement);
  const count = (sql: string) =>
    Number((db.prepare(sql).get() as { n: number } | undefined)?.n);
  assert.equal(count(`SELECT count(*) n FROM products WHERE id='cpu-0'`), 0);
  assert.equal(count(`SELECT count(*) n FROM prebuilts WHERE id='pc-0'`), 0);
  assert.equal(count(`SELECT count(*) n FROM sessions WHERE id='legacy'`), 0);
  assert.equal(
    count(`SELECT count(*) n FROM conversations WHERE id='legacy'`),
    0,
  );
  assert.equal(
    count(`SELECT count(*) n FROM products WHERE id='merchant-cpu'`),
    1,
  );
  assert.equal(count(`SELECT count(*) n FROM sessions WHERE id='current'`), 1);
  for (const statement of readFileSync(
    new URL('../../drizzle/0004_task_memory.sql', import.meta.url),
    'utf8',
  ).split('--> statement-breakpoint'))
    if (statement.trim()) db.exec(statement);
  db.exec(
    `INSERT INTO tasks VALUES ('task-a','session-a','游戏主机','{}',NULL,'[]',1,1),('task-b','session-b','办公主机','{}',NULL,'[]',1,1);`,
  );
  assert.equal(
    count(
      `SELECT count(*) n FROM tasks WHERE id='task-a' AND session_id='session-a'`,
    ),
    1,
  );
  assert.equal(
    count(
      `SELECT count(*) n FROM tasks WHERE id='task-a' AND session_id='session-b'`,
    ),
    0,
  );
});
void test('知识检索返回有来源的DDR文档', () => {
  const docs = retrieveKnowledge('DDR4 DDR5 内存 主板');
  assert.ok(docs.some((d) => d.id === 'compat-memory' && d.source));
});
void test('目录搜索支持类别、品牌、型号、颜色和价格区间', () => {
  const matches = searchCatalog(parts, {
    category: 'gpu',
    brand: '微星',
    modelKeyword: 'RTX 5070',
    color: '白色',
    minPrice: 6500,
    maxPrice: 7500,
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.id, 'real-gpu-18');
  const versions = searchCatalog(parts, {
    category: 'gpu',
    modelKeyword: 'RTX 5070',
  });
  assert.ok(versions.length > 1);
  assert.throws(
    () => searchCatalog(parts, { minPrice: 10, maxPrice: 1 }),
    /价格区间/,
  );
});
void test('自主组装只接受数据库八类 ID，并重算价格和约束', () => {
  const base = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0]!;
  const ids = base.parts.map((p) => p.id),
    selectedGpu = base.parts.find((p) => p.category === 'gpu')!;
  const constrained = {
    ...req,
    mode: 'diy' as const,
    partPreferences: { gpu: selectedGpu.id },
  };
  const plan = assembleBuild(ids, constrained, parts);
  assert.equal(
    plan.total,
    base.parts.reduce((sum, p) => sum + p.price, 0),
  );
  assert.equal(
    plan.parts.find((p) => p.category === 'gpu')?.id,
    selectedGpu.id,
  );
  assert.throws(
    () => assembleBuild(ids.slice(0, 7), constrained, parts),
    /八类/,
  );
  assert.throws(
    () => assembleBuild([...ids.slice(0, 7), 'missing'], constrained, parts),
    /不存在/,
  );
  assert.throws(
    () => assembleBuild([...ids.slice(0, 7), ids[0]!], constrained, parts),
    /不重复/,
  );
  assert.throws(
    () =>
      assembleBuild(ids, { ...constrained, budget: 1, hardCap: true }, parts),
    /预算/,
  );
  assert.throws(
    () => assembleBuild(ids, { ...constrained, mode: 'prebuilt' }, parts),
    /整机模式/,
  );
  const anotherGpu = parts.find(
    (p) => p.category === 'gpu' && p.id !== selectedGpu.id,
  )!;
  assert.throws(
    () =>
      assembleBuild(
        ids.map((id) => (id === selectedGpu.id ? anotherGpu.id : id)),
        constrained,
        parts,
      ),
    /指定型号/,
  );
  const incompatible = base.parts.map((p) => structuredClone(p)),
    memory = incompatible.find((p) => p.category === 'memory')!;
  memory.specs.ddr = memory.specs.ddr === 'DDR4' ? 'DDR5' : 'DDR4';
  assert.throws(
    () =>
      assembleBuild(
        incompatible.map((p) => p.id),
        req,
        incompatible,
      ),
    /不匹配/,
  );
});

function toolRuntime(): ToolRuntime {
  return {
    draft: {},
    result: null,
    explicitPatch: {},
    approvedPartIds: new Set(),
    attemptedPlanTool: false,
    successfulPlanTool: '',
    ambiguousSearch: false,
    emptySearch: false,
    specifiedUpdated: false,
    toolsUsed: [],
    toolErrors: [],
  };
}

void test('工具注册名称唯一，重复名称在注册阶段失败', () => {
  const names = registeredTools.map((tool) => tool.definition.function.name);
  assert.equal(new Set(names).size, names.length);
  const duplicate: RegisteredTool = {
    definition: {
      type: 'function',
      function: {
        name: 'duplicate',
        description: 'fixture',
        parameters: { type: 'object' },
      },
    },
    execute: async () => ({ ok: true }),
  };
  assert.throws(() => createToolRegistry([duplicate, duplicate]), /名称重复/);
});

void test('非法工具参数不会进入目录业务执行，未知工具返回可处理错误', async () => {
  let reloads = 0;
  const runtime = toolRuntime(),
    context = {
      catalog: { parts, prebuilts },
      reloadCatalog: async () => {
        reloads++;
        return { parts, prebuilts };
      },
    };
  const invalid = (await executeRegisteredTool(
    'search_catalog',
    { category: 'gpu', unexpected: true },
    context,
    runtime,
  )) as { error?: string };
  assert.match(invalid.error ?? '', /未知字段/);
  assert.equal(reloads, 0);
  const unknown = (await executeRegisteredTool(
    'not_registered',
    {},
    context,
    runtime,
  )) as { error?: string };
  assert.match(unknown.error ?? '', /不支持的工具/);
});

void test('组装工具不能绕过预算与兼容性校验', async () => {
  const base = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0]!;
  const runtime = toolRuntime();
  runtime.draft = { ...req, mode: 'diy', budget: 1, hardCap: true };
  const context = {
    catalog: { parts, prebuilts },
    reloadCatalog: async () => ({ parts, prebuilts }),
  };
  const budgetFailure = (await executeRegisteredTool(
    'assemble_build',
    { productIds: base.parts.map((part) => part.id) },
    context,
    runtime,
  )) as { error?: string };
  assert.match(budgetFailure.error ?? '', /预算/);
  const incompatible = base.parts.map((part) => structuredClone(part));
  incompatible.find((part) => part.category === 'memory')!.specs.ddr =
    'invalid';
  const compatibilityRuntime = toolRuntime();
  compatibilityRuntime.draft = { ...req, mode: 'diy' };
  const compatibilityFailure = (await executeRegisteredTool(
    'assemble_build',
    { productIds: incompatible.map((part) => part.id) },
    {
      catalog: { parts: incompatible, prebuilts },
      reloadCatalog: async () => ({ parts: incompatible, prebuilts }),
    },
    compatibilityRuntime,
  )) as { error?: string };
  assert.match(compatibilityFailure.error ?? '', /不匹配/);
});

void test('历史方案恢复时剔除 fps 字段且保留其他任务数据', () => {
  const legacy = {
    id: 'task-a',
    draft: { budget: 6000 },
    result: {
      requirements: req,
      plans: [
        {
          ...recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0],
          fps: { message: 'legacy' },
        },
      ],
      summary: '保留',
    },
    fps: 'root',
  };
  const cleaned = stripLegacyFps(legacy) as typeof legacy;
  assert.equal(cleaned.id, 'task-a');
  assert.equal(cleaned.result.summary, '保留');
  assert.equal(Object.hasOwn(cleaned, 'fps'), false);
  assert.equal(Object.hasOwn(cleaned.result.plans[0], 'fps'), false);
});
