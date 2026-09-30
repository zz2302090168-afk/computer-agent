import assert from 'node:assert/strict';
import test from 'node:test';
import { addSyntheticThermalEvidence } from './thermal-fixture';
import type { Catalog, Prebuilt, Requirements } from '../domain/types';
import { budgetRange } from '../rules/budget';
import { auditDelivery } from '../services/delivery-audit';
import { editPlan } from '../services/edit-plan';
import {
  assembleBuild,
  recommend,
  selectPrebuilt,
} from '../services/recommend';
import { fixture } from './pc-fixture';
import { assembleBuildTool } from '../tools/build/assemble';
import { searchCatalog } from '../services/catalog-search';

function budgetFixture() {
  const source = fixture();
  const parts = source.catalog.parts.filter(
    (part) => part.id === part.category,
  );
  const requirements: Requirements = {
    ...source.runtime.result!.requirements,
    budget: 7500,
    budgetTolerance: 1000,
    mode: 'both',
  };
  const pc = (id: string, price: number): Prebuilt => ({
    id,
    name: `测试整机 ${id}`,
    brand: '测试品牌',
    color: '黑色',
    price,
    partIds: parts.map((part) => part.id),
    demo: true,
  });
  return { source, parts, requirements, pc };
}

void test('CPU 型号查询、推荐和交付审核共用精确匹配，不混淆数字型号或后缀', () => {
  const { source, parts } = budgetFixture();
  for (const [keyword, name, otherName] of [
    ['5700X', 'Ryzen 7 5700X', 'Ryzen 7 5700X3D'],
    ['7600', 'Ryzen 5 7600', 'Ryzen 5 7600X'],
    ['AMD Ryzen 7 5700X', 'Ryzen 7 5700X', 'Ryzen 7 5700X3D'],
    ['Core i5-14600K', 'Core i5-14600K', 'Core i5-14600KF'],
  ] as const) {
    const catalog = {
      parts: parts.map((part) =>
        part.category === 'cpu' ? { ...part, name } : part,
      ),
      prebuilts: [],
    };
    const requirements = {
      ...source.runtime.result!.requirements,
      seriesPreferences: { cpu: keyword },
    };
    assert.deepEqual(
      searchCatalog(catalog.parts, {
        category: 'cpu',
        modelKeyword: keyword,
      }).map((part) => part.id),
      ['cpu'],
      keyword,
    );
    const plans = recommend(requirements, catalog.parts, []);
    assert.equal(plans.length, 1, keyword);
    assert.equal(
      auditDelivery(plans, requirements, catalog)[0]!.deliveryAudit?.status,
      'passed',
      keyword,
    );
    const changedCatalog = {
      ...catalog,
      parts: catalog.parts.map((part) =>
        part.category === 'cpu' ? { ...part, name: otherName } : part,
      ),
    };
    assert.equal(
      searchCatalog(changedCatalog.parts, {
        category: 'cpu',
        modelKeyword: keyword,
      }).length,
      0,
      keyword,
    );
    assert.equal(recommend(requirements, changedCatalog.parts, []).length, 0);
    assert.throws(
      () => auditDelivery(plans, requirements, changedCatalog),
      /不符合指定系列/,
      keyword,
    );
  }
});

void test('统一型号匹配保留显卡 Ti、SUPER 区分及普通系列关键词查询', () => {
  const { source, parts } = budgetFixture();
  for (const keyword of ['5060', '5060 Ti', '5060 SUPER', '5060 Ti SUPER']) {
    const catalog = {
      parts: parts.map((part) =>
        part.category === 'gpu'
          ? { ...part, name: `GeForce RTX ${keyword} VENTUS 2X OC` }
          : part,
      ),
      prebuilts: [],
    };
    for (const wanted of ['5060', '5060 Ti', '5060 SUPER', '5060 Ti SUPER']) {
      const requirements = {
        ...source.runtime.result!.requirements,
        seriesPreferences: { gpu: wanted },
      };
      const expected = wanted === keyword ? 1 : 0;
      assert.equal(
        searchCatalog(catalog.parts, {
          category: 'gpu',
          modelKeyword: wanted,
        }).length,
        expected,
        `${wanted} / ${keyword}`,
      );
      assert.equal(recommend(requirements, catalog.parts, []).length, expected);
    }
    const requirements = {
      ...source.runtime.result!.requirements,
      seriesPreferences: { gpu: 'VENTUS   2X' },
    };
    assert.equal(
      searchCatalog(catalog.parts, {
        category: 'gpu',
        modelKeyword: 'VENTUS 2X',
        brand: '测试品牌',
      }).length,
      1,
    );
    assert.equal(recommend(requirements, catalog.parts, []).length, 1);
  }
});

void test('混合目录推荐与交付审核共用 DIY 和整机 L/H，不把合格方案改成超预算参考', () => {
  const { parts, requirements, pc } = budgetFixture();
  const catalog: Catalog = { parts, prebuilts: [pc('pc-low', 6000)] };
  const plans = recommend(requirements, parts, catalog.prebuilts);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.total, 8000);
  const audited = auditDelivery(plans, requirements, catalog)[0]!;
  assert.deepEqual(audited.budget, plans[0]!.budget);
  assert.equal(audited.budget.minimumReference, 6000);
  assert.equal(audited.budget.highReference, 8000);
  assert.equal(audited.budget.status, 'standard');
  assert.equal(audited.deliveryAudit?.status, 'passed');
});

void test('混合目录自主组装在审核前也使用整机边界，允许区间内非最低 DIY', async () => {
  const { source, parts, requirements, pc } = budgetFixture();
  const gpu = parts.find((part) => part.category === 'gpu')!;
  const catalog: Catalog = {
    parts: [...parts, { ...gpu, id: 'gpu-1500', price: 1500 }],
    prebuilts: [pc('pc-low', 6000)],
  };
  const ids = parts.map((part) =>
    part.category === 'gpu' ? 'gpu-1500' : part.id,
  );
  addSyntheticThermalEvidence(catalog.parts);
  const plan = assembleBuild(
    ids,
    requirements,
    catalog.parts,
    catalog.prebuilts,
  );
  assert.equal(plan.total, 8500);
  assert.equal(plan.budget.status, 'standard');
  assert.equal(
    auditDelivery([plan], requirements, catalog)[0]!.budget.confirmable,
    true,
  );
  source.context.catalog = catalog;
  source.context.reloadCatalog = async () => catalog;
  source.runtime.draft = requirements;
  await assembleBuildTool.execute(
    { productIds: ids },
    source.context,
    source.runtime,
  );
  assert.equal(source.runtime.result!.plans[0]!.total, 8500);
  assert.equal(
    source.runtime.result!.plans[0]!.deliveryAudit?.status,
    'passed',
  );
});

void test('要求最贵时拒绝低于实际最高的候选，推荐的最高配置可通过统一审核', () => {
  const { source } = budgetFixture();
  const requirements = {
    ...source.runtime.result!.requirements,
    budget: 8500,
    budgetTolerance: 1000,
  };
  const lower = source.runtime.result!.plans[1]!;
  const expensive = { ...requirements, preferExpensive: true };
  assert.throws(
    () => auditDelivery([lower], expensive, source.catalog),
    /最高价方案，应为 ¥9051/,
  );
  const highest = recommend(expensive, source.catalog.parts, []);
  assert.equal(highest[0]!.total, 9051);
  assert.equal(
    auditDelivery(highest, expensive, source.catalog)[0]!.deliveryAudit?.status,
    'passed',
  );
});

void test('最贵取预算区间内的最高价，尊重误差和明确上限，不强求整个目录 H', () => {
  const { source } = budgetFixture();
  const requirements = {
    ...source.runtime.result!.requirements,
    preferExpensive: true,
  };
  const highest = recommend(requirements, source.catalog.parts, []);
  assert.equal(highest[0]!.total, 8050);
  assert.equal(
    auditDelivery(highest, requirements, source.catalog)[0]!.total,
    8050,
  );
  assert.throws(
    () =>
      auditDelivery(
        [source.runtime.result!.plans[1]!],
        requirements,
        source.catalog,
      ),
    /最高价方案，应为 ¥8050/,
  );
  const capped = { ...requirements, hardCap: true };
  assert.equal(
    auditDelivery(
      [source.runtime.result!.plans[1]!],
      capped,
      source.catalog,
    )[0]!.total,
    8000,
  );
});

void test('混合模式下最高价会比较整机售价，自主组装和整机选择不能绕过', () => {
  const { parts, requirements, pc } = budgetFixture();
  const catalog = {
    parts,
    prebuilts: [pc('pc-low', 8000), pc('pc-high', 8500)],
  };
  const expensive = { ...requirements, budget: 8000, preferExpensive: true };
  assert.throws(
    () =>
      assembleBuild(
        parts.map((part) => part.id),
        expensive,
        parts,
        catalog.prebuilts,
      ),
    /最高价方案，应为 ¥8500/,
  );
  assert.throws(
    () => selectPrebuilt('pc-low', expensive, parts, catalog.prebuilts),
    /最高价方案/,
  );
  const highest = selectPrebuilt(
    'pc-high',
    expensive,
    parts,
    catalog.prebuilts,
  );
  assert.equal(auditDelivery([highest], expensive, catalog)[0]!.total, 8500);
  assert.equal(highest.validation.status, 'not_applicable');
});

void test('预算高于 H 只能交付 H，低价 DIY 和整机不能伪装成最高参考', () => {
  const { source, parts, requirements, pc } = budgetFixture();
  const above = { ...source.runtime.result!.requirements, budget: 10000 };
  assert.deepEqual(budgetRange(10000, false, { minimum: 7849, high: 9051 }), {
    min: 9051,
    max: 9051,
    reference: true,
  });
  assert.throws(
    () =>
      auditDelivery([source.runtime.result!.plans[1]!], above, source.catalog),
    /目录最高参考 ¥9051/,
  );
  const highest = recommend(above, source.catalog.parts, []);
  assert.equal(
    auditDelivery(highest, above, source.catalog)[0]!.budget.confirmable,
    true,
  );
  const prebuilts = [pc('pc-low', 8000), pc('pc-high', 8500)];
  const prebuiltRequirements = {
    ...requirements,
    mode: 'prebuilt' as const,
    budget: 10000,
  };
  assert.throws(
    () => selectPrebuilt('pc-low', prebuiltRequirements, parts, prebuilts),
    /目录最高参考 ¥8500/,
  );
  assert.equal(
    selectPrebuilt('pc-high', prebuiltRequirements, parts, prebuilts).total,
    8500,
  );
});

void test('预算低于 L 仍只交付不可确认的完整参考；L/H 等值维持标准区间', () => {
  const { parts, requirements, pc } = budgetFixture();
  const catalog = { parts, prebuilts: [pc('pc-low', 6000)] };
  const below = { ...requirements, budget: 1000 };
  const reference = auditDelivery(
    recommend(below, parts, catalog.prebuilts),
    below,
    catalog,
  )[0]!;
  assert.equal(reference.total, 6000);
  assert.equal(reference.parts.length, 8);
  assert.equal(reference.budget.confirmable, false);
  assert.equal(reference.deliveryAudit?.status, 'reference');
  for (const budget of [6000, 8000]) {
    const boundary = { ...requirements, budget };
    const plans = auditDelivery(
      recommend(boundary, parts, catalog.prebuilts),
      boundary,
      catalog,
    );
    assert.ok(
      plans.every(
        (plan) => plan.budget.status === 'standard' && plan.budget.confirmable,
      ),
    );
  }
});

void test('明确局部替换按新指定型号计算最高参考，不沿用旧 H 拒绝新方案', () => {
  const { source, parts, requirements } = budgetFixture();
  const gpu = parts.find((part) => part.category === 'gpu')!;
  const catalog = {
    parts: [...parts, { ...gpu, id: 'gpu-selected', price: 950 }],
    prebuilts: [],
  };
  const above = { ...requirements, mode: 'diy' as const, budget: 10000 };
  addSyntheticThermalEvidence(catalog.parts);
  const highest = recommend(above, catalog.parts, []);
  const task = {
    ...source.runtime.task,
    draft: above,
    result: { requirements: above, plans: highest, summary: '测试最高参考' },
  };
  const edited = editPlan(
    task,
    highest[0]!.id,
    [{ oldId: 'gpu', newId: 'gpu-selected' }],
    catalog,
  );
  const updated = edited.result.plans[0]!;
  assert.equal(updated.total, 7950);
  assert.equal(updated.budget.highReference, 7950);
  assert.equal(updated.deliveryAudit?.status, 'passed');
  assert.equal(
    updated.parts
      .filter((part) => part.category !== 'gpu')
      .every((part) => highest[0]!.parts.some((old) => old.id === part.id)),
    true,
  );
});
