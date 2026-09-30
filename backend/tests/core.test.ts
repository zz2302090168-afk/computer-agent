import { fixture } from './pc-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withinBudget, budgetRange } from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import {
  assembleBuild,
  findDiyBudgetReferences,
  recommend,
  replacePart,
  selectPrebuilt,
} from '../services/recommend';
import { matchesExclusions, searchCatalog } from '../services/catalog-search';
import { auditDelivery } from '../services/delivery-audit';
import { parts, prebuilts } from '../../data/seed/catalog';
import { retrieveKnowledge } from '../rag/retrieve';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';
import {
  applyDraft,
  changesRecommendation,
  completeRequirements,
} from '../agent/conversation-state';
import {
  createToolRegistry,
  executeRegisteredTool,
  registeredTools,
} from '../tools/registry';
import type { RegisteredTool, ToolContext, ToolRuntime } from '../tools/types';
import type { Requirements } from '../domain/types';
import { stripLegacyFps } from '../domain/sanitize';
import { readFileSync } from 'node:fs';
import { conversationToolChoice } from '../agent/conversation';
import { matchesRequirementColor, requiredPartColor } from '../rules/color';
import { searchCatalogTool } from '../tools/catalog';
import { assertSameOrigin } from '../api/http';
import { buildConversationPrompt } from '../agent/prompts';
import { updateRequirementsTool } from '../tools/requirements/update';
const req: Requirements = {
  budget: 6000,
  purpose: '游戏',
  mode: 'both',
  color: '不限',
  hardCap: false,
  message: '',
  brand: '',
  game: '',
};
void test('CPU品牌误填型号时按目录归位，旧错误需求也能恢复推荐', async () => {
  for (const brand of ['AMD', 'Intel', '英特尔']) {
    const f = fixture();
    f.context.catalog = { parts, prebuilts };
    f.runtime.result = null;
    f.runtime.draft = {
      budget: 10000,
      purpose: '游戏',
      mode: 'diy',
      seriesPreferences: { cpu: brand },
    };
    const previous = f.runtime.draft;
    await updateRequirementsTool.execute({}, f.context, f.runtime);
    assert.equal(f.runtime.draft.seriesPreferences?.cpu, undefined);
    assert.ok(f.runtime.draft.brandPreferences?.cpu?.includes(brand));
    assert.deepEqual(previous.seriesPreferences, { cpu: brand });
    assert.equal(f.saved.length, 1);
    const requirements = completeRequirements(f.runtime.draft);
    const plans = recommend(requirements, parts, prebuilts);
    assert.ok(plans.length > 0);
    // 目录的推定规格仍可用于候选搜索，但用户要求 unknown 不得最终交付。
    assert.throws(
      () => auditDelivery(plans, requirements, { parts, prebuilts }),
      /适配性无法确认/,
    );
  }
});
void test('品牌归位不改具体型号、否定条件或冲突需求，也不绕过局部修改边界', async () => {
  for (const series of ['7800X3D', 'Ryzen 7', '不要AMD', '不存在的型号']) {
    const f = fixture();
    f.context.catalog = { parts, prebuilts };
    f.runtime.result = null;
    f.runtime.draft = {};
    await updateRequirementsTool.execute(
      { seriesPreferences: { cpu: series } },
      f.context,
      f.runtime,
    );
    assert.equal(f.runtime.draft.seriesPreferences?.cpu, series);
    assert.equal(f.runtime.draft.brandPreferences?.cpu, undefined);
  }
  const f = fixture();
  f.context.catalog = { parts, prebuilts };
  await assert.rejects(
    updateRequirementsTool.execute(
      { seriesPreferences: { cpu: 'AMD' } },
      f.context,
      f.runtime,
    ),
    /配件级修改/,
  );
  f.runtime.result = null;
  f.runtime.draft = { brandPreferences: { cpu: 'Intel' } };
  await assert.rejects(
    updateRequirementsTool.execute(
      { seriesPreferences: { cpu: 'AMD' } },
      f.context,
      f.runtime,
    ),
    /品牌冲突/,
  );
  assert.deepEqual(f.runtime.draft, { brandPreferences: { cpu: 'Intel' } });
});
void test('组装机与DIY措辞在系统提示中路由到不同购买方式', () => {
  const prompt = buildConversationPrompt({
    taskId: 'task',
    currentMessageId: 'message',
    draft: {},
    result: null,
    tasks: [],
    facts: [],
  });
  assert.match(prompt, /“9000预算组装机”[\s\S]*"mode":"prebuilt"/);
  assert.match(prompt, /“9000预算DIY”[\s\S]*"mode":"diy"/);
});
void test('同源校验使用浏览器实际访问主机并拒绝跨站来源', () => {
  assert.doesNotThrow(() =>
    assertSameOrigin(
      new Request('http://localhost:3000/api/chat', {
        method: 'PUT',
        headers: {
          host: '192.168.1.5:3000',
          origin: 'http://192.168.1.5:3000',
        },
      }),
    ),
  );
  assert.throws(
    () =>
      assertSameOrigin(
        new Request('http://localhost:3000/api/chat', {
          method: 'PUT',
          headers: {
            host: '192.168.1.5:3000',
            origin: 'https://example.com',
          },
        }),
      ),
    /拒绝跨站写入请求/,
  );
});
void test('配置仍需探索时强制模型继续调用工具', () => {
  assert.equal(
    conversationToolChoice({ status: 'continue', reason: '待生成' }, 1, 16),
    'required',
  );
  assert.equal(conversationToolChoice(undefined, 1, 16), 'auto');
  assert.equal(conversationToolChoice(undefined, 15, 16), 'none');
});
void test('CPU和硬盘不接受颜色约束或颜色查询', async () => {
  const f = fixture();
  const storage = f.catalog.parts.find((part) => part.category === 'storage')!;
  assert.equal(requiredPartColor(storage, { color: '白色' }), undefined);
  assert.throws(() => applyDraft({}, { partColors: { storage: '白色' } }));
  await assert.rejects(
    searchCatalogTool.execute(
      { kind: 'part', category: 'storage', color: '白色' },
      f.context,
      f.runtime,
    ),
    /不参与配色/,
  );
});
void test('预算默认正负500边界，显式误差与明确上限保持有效', () => {
  assert.ok(withinBudget(5500, 6000));
  assert.ok(withinBudget(6500, 6000));
  assert.ok(!withinBudget(5499.99, 6000));
  assert.ok(!withinBudget(6500.01, 6000));
  assert.ok(!withinBudget(6000.01, 6000, true));
  assert.deepEqual(budgetRange(10000), {
    min: 9500,
    max: 10500,
    reference: false,
  });
  assert.deepEqual(budgetRange(10000, false, undefined, 0), {
    min: 10000,
    max: 10000,
    reference: false,
  });
  assert.ok(withinBudget(7000, 6000, false, undefined, 1000));
  for (const x of [NaN, Infinity, -1, 0]) assert.throws(() => budgetRange(x));
});
void test('保留原160个商品并扩充演示目录，无库存数量或在售字段', () => {
  const original = parts.filter((p) => !p.demo);
  assert.equal(original.length, 160);
  assert.ok(parts.length > original.length);
  assert.equal(new Set(parts.map((p) => p.id)).size, parts.length);
  for (const c of new Set(original.map((p) => p.category)))
    assert.equal(original.filter((p) => p.category === c).length, 20);
  for (const p of parts) {
    assert.ok(!('stock' in p));
    assert.ok(!('status' in p));
    assert.match(String(p.specs.source), /^https:\/\//);
    assert.equal(typeof p.demo, 'boolean');
    if (p.demo) assert.match(String(p.specs.priceBasis), /演示/);
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
void test('推定兼容规格有可审计来源，且不会伪装为厂家核实', () => {
  const fields: [string, string][] = [
    ['motherboard', 'supportedCpus'],
    ['motherboard', 'maxRam'],
    ['case', 'gpuThickness'],
    ['memory', 'height'],
    ['cooler', 'ramClearance'],
    ['psu', 'connectorCounts'],
  ];
  for (const [category, field] of fields) {
    const entries = parts.filter((part) => part.category === category);
    let inferredCount = 0;
    assert.ok(entries.length);
    for (const part of entries) {
      assert.notEqual(part.specs[field], undefined);
      if (
        !Array.isArray(part.specs.inferredFields) ||
        !part.specs.inferredFields.includes(field)
      )
        continue;
      inferredCount++;
      const provenance = part.specs.provenance as Record<
        string,
        Record<string, unknown>
      >;
      assert.equal(provenance[field]?.origin, 'synthetic');
      assert.equal(provenance[field]?.status, 'inferred');
      assert.equal(provenance[field]?.manufacturerVerified, false);
    }
    assert.ok(inferredCount);
  }
  for (const board of parts.filter((part) => part.category === 'motherboard')) {
    assert.equal(board.specs.biosVerified, false);
    const provenance = board.specs.provenance as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(provenance.biosVerified?.status, 'unverified');
    assert.equal(provenance.biosVerified?.manufacturerVerified, false);
  }
});
void test('推定值可初筛冲突，但通过时仍保留推定假设', () => {
  const f = fixture();
  const inferred = structuredClone(f.runtime.result!.plans[0]!.parts);
  const byCategory = Object.fromEntries(
    inferred.map((part) => [part.category, part]),
  );
  const board = byCategory.motherboard!;
  board.specs.provenance = {
    supportedCpus: { origin: 'synthetic', status: 'inferred' },
  };
  board.specs.inferredFields = ['supportedCpus'];
  const screened = validateBuild(inferred);
  assert.equal(screened.status, 'unknown');
  assert.ok(screened.issues.some((item) => item.includes('推定值初筛通过')));
  const box = byCategory.case!;
  box.specs.gpuThickness = 30;
  box.specs.provenance = {
    gpuThickness: { origin: 'synthetic', status: 'inferred' },
  };
  box.specs.inferredFields = ['gpuThickness'];
  const rejected = validateBuild(inferred);
  assert.equal(rejected.status, 'fail');
  assert.ok(rejected.issues.some((item) => item.includes('基于推定值初筛')));
});
void test('全部商家整机均引用数据库中八类完整商品', () => {
  assert.equal(prebuilts.filter((pc) => !pc.demo).length, 20);
  for (const pc of prebuilts) {
    const ps = pc.partIds.map((id) => parts.find((p) => p.id === id)!);
    assert.equal(pc.partIds.length, 8, pc.id);
    assert.equal(new Set(ps.map((p) => p.category)).size, 8, pc.id);
    assert.ok(ps.every(Boolean), pc.id);
  }
});
void test('原六类配色商品各半，白色候选完整但资料不足不得交付', () => {
  const coloredCategories = [
    'gpu',
    'memory',
    'motherboard',
    'psu',
    'case',
    'cooler',
  ];
  for (const category of coloredCategories) {
    const items = parts.filter(
      (part) => part.category === category && !part.demo,
    );
    assert.equal(
      items.filter((part) => part.color === '白色').length,
      10,
      category,
    );
    assert.equal(
      items.filter((part) => part.color.includes('黑色')).length,
      10,
      category,
    );
  }
  const requirements: Requirements = {
    ...req,
    budget: 9000,
    color: '白色',
    mode: 'diy',
  };
  const plans = recommend(requirements, parts, prebuilts);
  assert.ok(plans.length > 0);
  assert.throws(
    () => auditDelivery(plans, requirements, { parts, prebuilts }),
    /适配性无法确认/,
  );
  for (const plan of plans) {
    assert.equal(plan.parts.length, 8);
    assert.equal(plan.deliveryAudit, undefined);
    assert.ok(
      plan.parts
        .filter((part) => coloredCategories.includes(part.category))
        .every((part) => part.color === '白色'),
    );
    assert.notEqual(plan.validation.status, 'fail');
  }
});
void test('扩充目录支持Intel两代平台、DDR4与白色配置，保留AMD推荐', () => {
  for (const patch of [
    { budget: 20000, brandPreferences: { cpu: 'Intel' } },
    {
      budget: 5000,
      brandPreferences: { cpu: 'Intel' },
      seriesPreferences: { motherboard: 'PRIME B760M-A D4' },
    },
    { budget: 20000, seriesPreferences: { cpu: 'Core Ultra 7 265K' } },
    { budget: 12000, color: '白色', brandPreferences: { cpu: 'Intel' } },
    { budget: 8000, brandPreferences: { cpu: 'AMD' } },
  ]) {
    const requirements: Requirements = {
      ...req,
      mode: 'diy',
      game: '三角洲',
      ...patch,
    };
    const plans = recommend(requirements, parts, prebuilts);
    assert.ok(plans.length > 0, JSON.stringify(patch));
    assert.throws(
      () => auditDelivery(plans, requirements, { parts, prebuilts }),
      /适配性无法确认/,
    );
    for (const plan of plans) {
      assert.equal(plan.parts.length, 8);
      assert.equal(plan.deliveryAudit, undefined);
      assert.ok(withinBudget(plan.total, requirements.budget));
      assert.notEqual(plan.validation.status, 'fail');
      if (patch.brandPreferences)
        assert.ok(
          plan.parts
            .find((part) => part.category === 'cpu')!
            .brand.includes(patch.brandPreferences.cpu),
        );
      if (plan.parts.some((part) => part.demo)) assert.equal(plan.demo, true);
    }
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
void test('商家整机不执行DIY配件兼容性审核但仍完成交付核验', () => {
  const catalog = structuredClone(parts),
    pc = structuredClone(prebuilts[0]),
    selected = pc.partIds.map((id) => catalog.find((part) => part.id === id)!);
  selected.find((part) => part.category === 'memory')!.specs.ddr = 'DDR5';
  assert.equal(validateBuild(selected).status, 'fail');
  const requirements: Requirements = {
      ...req,
      budget: pc.price,
      mode: 'prebuilt',
    },
    plan = selectPrebuilt(pc.id, requirements, catalog, [pc]),
    audited = auditDelivery([plan], requirements, {
      parts: catalog,
      prebuilts: [pc],
    })[0]!;
  assert.equal(audited.validation.status, 'not_applicable');
  assert.deepEqual(audited.validation.issues, []);
  assert.equal(audited.deliveryAudit?.status, 'passed');
});
void test('所有预算用途返回的配置均满足硬约束', () => {
  let count = 0;
  for (const budget of [3000, 6000, 10000, 18000, 30000])
    for (const purpose of ['游戏', '办公', '编程', '本地 AI']) {
      const r = { ...req, budget, purpose };
      for (const p of recommend(r, parts, prebuilts)) {
        count++;
        assert.ok(
          p.budget.status === 'below_minimum_reference' ||
            p.budget.status === 'above_high_reference' ||
            withinBudget(p.total, budget),
        );
        assert.equal(p.parts.length, 8);
        assert.notEqual(validateBuild(p.parts).status, 'fail');
      }
    }
  assert.ok(count > 20);
});
void test('极低预算返回不可确认的完整超预算参考', () => {
  const plans = recommend(
    { ...req, budget: 1, hardCap: true },
    parts,
    prebuilts,
  );
  assert.ok(plans.length);
  assert.ok(plans.every((plan) => plan.parts.length === 8));
  assert.ok(
    plans.every((plan) => plan.budget.status === 'below_minimum_reference'),
  );
  assert.ok(plans.every((plan) => !plan.budget.confirmable));
});
void test('硬上限、白色与整机模式生效', () => {
  const r = { ...req, hardCap: true, color: '白色', mode: 'prebuilt' as const };
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
void test('替换时按最新目录刷新全部配件行价与总价', () => {
  const plan = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0]!;
  const target = plan.parts.find((part) => part.category === 'storage')!;
  const repriced = parts.map((part) =>
    part.id === target.id ? { ...part, price: part.price + 25 } : part,
  );
  const updated = replacePart(plan, target.id, target.id, req, repriced);
  assert.equal(
    updated.parts.find((part) => part.id === target.id)!.price,
    target.price + 25,
  );
  assert.equal(updated.total, plan.total + 25);
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
void test('结构化需求更新保留预算边界和购买方式', () => {
  const changed = applyDraft(
    { budget: 6000, purpose: '游戏', hardCap: false },
    { budget: 8000, hardCap: true, color: '白色', mode: 'prebuilt' },
  );
  assert.equal(changed.budget, 8000);
  assert.equal(changed.hardCap, true);
  assert.equal(changed.color, '白色');
  assert.equal(changed.mode, 'prebuilt');
  const cheaper = applyDraft(changed, { preferCheaper: true });
  assert.equal(cheaper.budget, 8000);
  assert.equal(cheaper.hardCap, true);
  assert.equal(cheaper.preferCheaper, true);
});
void test('系列授权有局部作用域，5070 不包含 5070 Ti', () => {
  const draft = applyDraft(
    {},
    {
      budget: 6000,
      purpose: '游戏',
      seriesPreferences: { gpu: 'RTX 5070' },
      selectionAuthorizations: { gpu: 'RTX 5070' },
    },
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
    assert.ok(
      plan.budget.status === 'below_minimum_reference' ||
        withinBudget(plan.total, 6000),
    );
  }
  const colorOnly = applyDraft(draft, { color: '不限' });
  assert.equal(colorOnly.color, '不限');
  assert.equal(colorOnly.budget, 6000);
  assert.equal(colorOnly.seriesPreferences?.gpu, 'RTX 5070');
  const low = recommend(
    completeRequirements({ ...draft, budget: 3000, hardCap: true }),
    parts,
    prebuilts,
  );
  assert.ok(low.length);
  assert.ok(
    low.every((plan) => plan.budget.status === 'below_minimum_reference'),
  );
});
void test('L/H 等值属于标准区间，超过 H 返回实际用途高档参考', () => {
  const refs = findDiyBudgetReferences({ ...req, mode: 'diy' }, parts);
  assert.ok(refs.minimum && refs.high && refs.highParts);
  const atL = recommend(
    { ...req, mode: 'diy', budget: refs.minimum! },
    parts,
    prebuilts,
  );
  assert.ok(atL.length);
  assert.ok(atL.every((plan) => plan.budget.status === 'standard'));
  const atH = recommend(
    { ...req, mode: 'diy', budget: refs.high! },
    parts,
    prebuilts,
  );
  assert.ok(atH.length);
  assert.ok(atH.every((plan) => plan.budget.status === 'standard'));
  const above = recommend(
    { ...req, mode: 'diy', budget: 200000 },
    parts,
    prebuilts,
  );
  assert.equal(above.length, 1);
  assert.equal(above[0]!.total, refs.high);
  assert.equal(above[0]!.budget.status, 'above_high_reference');
  const cheaper = recommend(
    { ...req, mode: 'diy', budget: 200000, preferCheaper: true },
    parts,
    prebuilts,
  );
  assert.equal(cheaper.length, 1);
  assert.equal(cheaper[0]!.total, refs.high);
});
void test('MySQL 初始迁移覆盖商品、任务和撤回数据表', () => {
  const sql = readFileSync(
    new URL('../../drizzle-mysql/0000_past_smiling_tiger.sql', import.meta.url),
    'utf8',
  );
  for (const table of [
    'products',
    'prebuilts',
    'metadata',
    'conversations',
    'tasks',
    'task_history',
  ])
    assert.match(sql, new RegExp('CREATE TABLE `' + table + '`'));
  assert.match(sql, /FOREIGN KEY \(`task_id`\).*ON DELETE cascade/);
  assert.doesNotMatch(sql, /sqlite|INSERT OR IGNORE|ON CONFLICT/i);
});
void test('知识检索返回有来源的DDR文档', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const docs = await retrieveKnowledge(embeddingConfig, 'DDR4 DDR5 内存 主板');
  assert.ok(docs.some((d) => d.id === 'compat-memory' && d.source));
});
void test('Embedding 语料缓存复用，失败后允许重试且不回退关键词', async (t) => {
  let corpusCalls = 0,
    failCorpus = true;
  t.mock.method(
    globalThis,
    'fetch',
    async (url: unknown, options?: RequestInit) => {
      const input = (JSON.parse(options?.body as string) as { input: string[] })
        .input;
      if (input.length > 1) {
        corpusCalls++;
        if (failCorpus) {
          failCorpus = false;
          return new Response(null, { status: 503 });
        }
      }
      return embeddingFetch(url, options);
    },
  );
  const config = { ...embeddingConfig, model: 'cache-retry-test' };
  await assert.rejects(
    retrieveKnowledge(config, 'DDR4 DDR5'),
    /Embedding 连接失败/,
  );
  await retrieveKnowledge(config, 'DDR4 DDR5');
  await retrieveKnowledge(config, '主板内存');
  assert.equal(corpusCalls, 2);
  await assert.rejects(
    retrieveKnowledge({}, 'DDR4 DDR5'),
    /Embedding 配置缺失/,
  );
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
    approvedPartIds: new Set(),
    toolsUsed: [],
    toolErrors: [],
    task: {
      id: 'task-a',
      name: '测试任务',
      draft: {},
      result: null,
      issues: [],
      version: 1,
      updatedAt: 1,
    },
    contextChanged: false,
    facts: [],
  };
}

function toolContext(): ToolContext {
  return {
    embeddingConfig,
    sessionId: 'session-a',
    taskId: 'task-a',
    currentMessageId: 'message-a',
    messages: [
      { id: 'message-a', role: 'user', content: '测试', taskId: 'task-a' },
    ],
    tasks: [],
    catalog: { parts, prebuilts },
    reloadCatalog: async () => ({ parts, prebuilts }),
    onTaskChange: async () => {},
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
      ...toolContext(),
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
  const context = toolContext();
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
      ...toolContext(),
      catalog: { parts: incompatible, prebuilts },
      reloadCatalog: async () => ({ parts: incompatible, prebuilts }),
    },
    compatibilityRuntime,
  )) as { error?: string };
  assert.match(compatibilityFailure.error ?? '', /不匹配/);
});
void test('低预算参考不能通过确认工具写成已确认', async () => {
  const runtime = toolRuntime(),
    plan = recommend(
      { ...req, mode: 'diy', budget: 1, hardCap: true },
      parts,
      prebuilts,
    )[0]!;
  runtime.draft = {
    ...req,
    mode: 'diy',
    budget: 1,
    hardCap: true,
    partSelections: Object.fromEntries(
      plan.parts.map((part) => [part.category, part.id]),
    ),
  };
  runtime.result = {
    requirements: completeRequirements(runtime.draft),
    plans: [plan],
    summary: '超预算参考',
  };
  const result = (await executeRegisteredTool(
    'confirm_selections',
    { categories: ['cpu'], sourceMessageId: 'message-a' },
    toolContext(),
    runtime,
  )) as { error?: string };
  assert.match(result.error ?? '', /适配性无法确认/);
  assert.equal(plan.budget.confirmable, false);
  assert.notEqual(runtime.draft.selectionSources?.cpu, 'confirmed');
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

void test('选择授权必须引用当前任务中的真实用户消息', async () => {
  const runtime = toolRuntime(),
    context = toolContext();
  runtime.draft = {
    budget: 6000,
    purpose: '游戏',
    seriesPreferences: { gpu: 'RTX 5060' },
  };
  const rejected = (await executeRegisteredTool(
    'authorize_selection',
    {
      category: 'gpu',
      scopeType: 'series',
      scope: 'RTX 5060',
      sourceMessageId: 'other-message',
    },
    context,
    runtime,
  )) as { error?: string };
  assert.match(rejected.error ?? '', /不属于当前任务/);
  const accepted = (await executeRegisteredTool(
    'authorize_selection',
    {
      category: 'gpu',
      scopeType: 'series',
      scope: 'RTX 5060',
      sourceMessageId: 'message-a',
    },
    context,
    runtime,
  )) as { operation: { requirementsChanged: boolean; failed: boolean } };
  assert.equal(accepted.operation.failed, false);
  assert.equal(accepted.operation.requirementsChanged, true);
  assert.equal(
    runtime.draft.selectionAuthorizationMessageIds?.gpu,
    'message-a',
  );
});

void test('方案评估只记录评估结果，不改变配件和报价', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const plan = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0]!,
    runtime = toolRuntime(),
    context = toolContext();
  runtime.draft = {
    ...req,
    partSelections: Object.fromEntries(
      plan.parts.map((part) => [part.category, part.id]),
    ),
  };
  runtime.result = {
    requirements: { ...req, partSelections: runtime.draft.partSelections },
    plans: [plan],
    summary: '测试',
  };
  const before = JSON.stringify(runtime.result.plans);
  const evaluated = (await executeRegisteredTool(
    'evaluate_plan',
    { focus: '还能改进吗' },
    context,
    runtime,
  )) as {
    operation: {
      partsChanged: boolean;
      quoteChanged: boolean;
      failed: boolean;
    };
  };
  assert.equal(evaluated.operation.failed, false);
  assert.equal(evaluated.operation.partsChanged, false);
  assert.equal(evaluated.operation.quoteChanged, false);
  assert.equal(JSON.stringify(runtime.result?.plans), before);
  assert.ok(runtime.result?.evaluation);
});

void test('普通推荐相邻目标相差500，保留硬上限与极值请求', () => {
  const base = fixture().catalog.parts.filter(
    (part) => part.id === part.category,
  );
  const storage = base.find((part) => part.category === 'storage')!;
  const catalog = [
    ...base,
    ...[1, 500, 999, 1001, 1500, 1999].map((price) => ({
      ...storage,
      id: `storage-${price}`,
      price,
    })),
  ];
  const requirements: Requirements = { ...req, mode: 'diy', budget: 8000 };
  const plans = recommend(requirements, catalog, []);
  assert.deepEqual(
    plans.map((plan) => plan.total).sort((a, b) => a - b),
    [7500, 8000, 8500],
  );
  assert.ok(
    recommend({ ...requirements, hardCap: true }, catalog, []).every(
      (plan) => plan.total <= 8000,
    ),
  );
  assert.equal(
    recommend({ ...requirements, preferCheaper: true }, catalog, [])[0]!.total,
    7500,
  );
  assert.equal(
    recommend({ ...requirements, preferExpensive: true }, catalog, [])[0]!
      .total,
    8500,
  );
  const pcs = [7001, 7500, 7999, 8000, 8001, 8500, 8999].map((price) => ({
    id: `pc-${price}`,
    name: `测试整机${price}`,
    price,
    partIds: base.map((part) => part.id),
    brand: '测试品牌',
    color: '黑色',
    demo: true,
  }));
  assert.deepEqual(
    recommend({ ...requirements, mode: 'prebuilt' }, base, pcs)
      .map((plan) => plan.total)
      .sort((a, b) => a - b),
    [7500, 8000, 8500],
  );
});

void test('两轮需求保留型号和颜色排除，AMD万元候选仍须补齐资料才能交付', () => {
  const first = applyDraft(
    {},
    {
      budget: 10000,
      mode: 'diy',
      color: '不限',
      excludedModels: { cpu: ['5600X'] },
      excludedColors: ['白色'],
    },
  );
  assert.throws(() => completeRequirements(first), /用途/);
  const second = applyDraft(first, {
    purpose: '游戏',
    brandPreferences: { cpu: 'AMD' },
  });
  const requirements = completeRequirements(second);
  const plans = recommend(requirements, parts, prebuilts);
  assert.ok(plans.length > 0);
  assert.throws(
    () => auditDelivery(plans, requirements, { parts, prebuilts }),
    /适配性无法确认/,
  );
  for (const plan of plans) {
    assert.equal(plan.deliveryAudit, undefined);
    assert.ok(Math.abs(plan.total - 10000) <= 500);
    const cpu = plan.parts.find((p) => p.category === 'cpu')!;
    assert.ok(cpu.brand.includes('AMD'));
    assert.ok(!cpu.name.toLowerCase().includes('5600x'));
    assert.ok(
      plan.parts
        .filter((p) => !['cpu', 'storage'].includes(p.category))
        .every((p) => !p.color.includes('白色')),
    );
    assert.throws(
      () =>
        assembleBuild(
          plan.parts.map((p) => p.id),
          { ...requirements, excludedModels: { cpu: [cpu.name] } },
          parts,
          prebuilts,
        ),
      /排除/,
    );
  }
  const cleared = applyDraft(second, {
    excludedModels: { cpu: [] },
    excludedColors: [],
  });
  assert.ok(changesRecommendation(second, cleared));
  assert.deepEqual(second.excludedModels, { cpu: ['5600X'] });
  assert.deepEqual(cleared.excludedModels, { cpu: [] });
});
void test('排除匹配不误伤相邻型号，颜色覆盖六类，品牌排除参与整机与DIY审核', () => {
  const cpu = parts.find((p) => p.category === 'cpu')!;
  const requirements = {
    ...req,
    excludedModels: { cpu: ['5600X'] },
    excludedColors: ['白色'],
  };
  assert.equal(
    matchesExclusions({ ...cpu, name: 'AMD Ryzen 5 5600X' }, requirements),
    false,
  );
  assert.equal(
    matchesExclusions({ ...cpu, name: 'AMD Ryzen 5 5600' }, requirements),
    true,
  );
  assert.equal(
    matchesExclusions({ ...cpu, name: 'AMD Ryzen 7 5700X' }, requirements),
    true,
  );
  for (const category of [
    'gpu',
    'memory',
    'motherboard',
    'psu',
    'case',
    'cooler',
  ] as const) {
    assert.equal(
      matchesRequirementColor(
        { ...cpu, category, color: '白色' },
        requirements,
      ),
      false,
    );
    assert.equal(
      matchesRequirementColor(
        { ...cpu, category, color: '灰色' },
        requirements,
      ),
      true,
    );
  }
  assert.equal(
    matchesRequirementColor({ ...cpu, color: '白色' }, requirements),
    true,
  );
  const pc = prebuilts[0];
  const prebuiltReq = { ...req, budget: pc.price, mode: 'prebuilt' as const };
  const plan = selectPrebuilt(pc.id, prebuiltReq, parts, prebuilts);
  const brand = plan.parts.find((p) => p.category === 'cpu')!.brand;
  assert.throws(() =>
    selectPrebuilt(
      pc.id,
      { ...prebuiltReq, excludedBrands: { cpu: [brand] } },
      parts,
      prebuilts,
    ),
  );
  const intel = recommend(
    { ...req, mode: 'diy', budget: 10000, excludedBrands: { cpu: ['AMD'] } },
    parts,
    prebuilts,
  );
  assert.ok(intel.length > 0);
  assert.ok(
    intel.every(
      (p) =>
        !p.parts.find((part) => part.category === 'cpu')!.brand.includes('AMD'),
    ),
  );
  for (const patch of [
    { excludedModels: { cpu: '5600X' } },
    { excludedColors: [''] },
    { excludedBrands: { invalid: ['AMD'] } },
  ])
    assert.throws(() => applyDraft({}, patch));
});

void test('零误差保留原值并提示可能无匹配，不擅自放宽预算', async () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.draft = {
    budget: 10000,
    purpose: '游戏',
    mode: 'diy',
    budgetTolerance: 0,
  };
  assert.throws(() => completeRequirements(f.runtime.draft), /等待确认/);
  assert.equal(applyDraft(f.runtime.draft, {}).budgetTolerance, 0);
  const result = await updateRequirementsTool.execute(
    { budgetTolerance: 0 },
    f.context,
    f.runtime,
  );
  assert.equal(f.runtime.draft.budgetTolerance, 0);
  assert.match(JSON.stringify(result), /可能找不到匹配配置/);
  assert.equal(f.runtime.requestAction, 'save_requirements');
  await assert.rejects(
    updateRequirementsTool.execute(
      { zeroBudgetConfirmationMessageId: f.context.currentMessageId },
      f.context,
      f.runtime,
    ),
    /等待后续/,
  );
  f.context.currentMessageId = 'confirm-zero';
  f.context.messages.push({
    id: 'confirm-zero',
    role: 'user',
    content: '确认坚持零误差',
    taskId: f.context.taskId,
  });
  await updateRequirementsTool.execute(
    { zeroBudgetConfirmationMessageId: 'confirm-zero' },
    f.context,
    f.runtime,
  );
  assert.equal(completeRequirements(f.runtime.draft).budgetTolerance, 0);

  assert.equal(withinBudget(10001, 10000, false, undefined, 0), false);
  assert.equal(withinBudget(10000, 10000, false, undefined, 0), true);
  const normal = await updateRequirementsTool.execute(
    { budgetTolerance: 50 },
    f.context,
    f.runtime,
  );
  assert.equal(f.runtime.draft.budgetTolerance, 50);
  assert.doesNotMatch(JSON.stringify(normal), /budgetNotice/);
  assert.deepEqual(budgetRange(10000), {
    min: 9500,
    max: 10500,
    reference: false,
  });
});
