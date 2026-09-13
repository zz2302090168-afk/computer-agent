import assert from 'node:assert/strict';
import test from 'node:test';
import { completeRequirements } from '../agent/conversation-state';
import { labels, type Catalog } from '../domain/types';
import { auditDelivery } from '../services/delivery-audit';
import {
  assembleBuild,
  recommend,
  selectPrebuilt,
} from '../services/recommend';
import { explainSelectionTool } from '../tools/build/explain';
import { searchCatalogTool } from '../tools/catalog/search';
import { fixture } from './pc-fixture';

function identityFixture() {
  const f = fixture();
  const ids = Object.keys(labels);
  const parts = f.catalog.parts
    .filter((part) => ids.includes(part.id))
    .map((part) => ({ ...part, demo: false }));
  const catalog: Catalog = {
    parts,
    prebuilts: [
      {
        id: 'identity-pc',
        name: '身份测试整机',
        brand: '测试商家',
        color: '黑色',
        price: 8000,
        partIds: parts.map((part) => part.id),
        demo: false,
      },
    ],
  };
  const requirements = completeRequirements({
    budget: 8000,
    purpose: '游戏',
    mode: 'prebuilt',
    color: '黑色',
  });
  return { f, catalog, requirements };
}

void test('演示整机即使八类配件均为真实型号，也在推荐和选择时保留演示身份', () => {
  const { catalog, requirements } = identityFixture();
  const pc = catalog.prebuilts[0]!;
  pc.demo = true;
  for (const budget of [7999, 8000, 9000]) {
    const current = { ...requirements, budget };
    const recommended = recommend(current, catalog.parts, catalog.prebuilts);
    assert.equal(recommended.length, 1);
    const plans = [
      recommended[0]!,
      selectPrebuilt(pc.id, current, catalog.parts, catalog.prebuilts),
    ];
    for (const plan of plans) {
      assert.equal(plan.kind, 'prebuilt');
      assert.equal(plan.demo, true);
      assert.ok(plan.parts.every((part) => part.demo === false));
    }
  }
});

void test('真实整机包含演示配件时标为含演示商品，全部真实时标为非演示', () => {
  const { catalog, requirements } = identityFixture();
  const pc = catalog.prebuilts[0]!;
  const gpu = catalog.parts.find((part) => part.category === 'gpu')!;
  for (const demo of [true, false]) {
    gpu.demo = demo;
    const plans = [
      ...recommend(requirements, catalog.parts, catalog.prebuilts),
      selectPrebuilt(pc.id, requirements, catalog.parts, catalog.prebuilts),
    ];
    assert.equal(pc.demo, false);
    for (const plan of plans) assert.equal(plan.demo, demo);
  }
});

void test('DIY 推荐与组装的演示标记来自八类实际配件', () => {
  const { catalog, requirements } = identityFixture();
  const current = { ...requirements, mode: 'diy' as const };
  const gpu = catalog.parts.find((part) => part.category === 'gpu')!;
  for (const demo of [false, true]) {
    gpu.demo = demo;
    const plans = [
      ...recommend(current, catalog.parts, catalog.prebuilts),
      assembleBuild(
        catalog.parts.map((part) => part.id),
        current,
        catalog.parts,
        catalog.prebuilts,
      ),
    ];
    assert.ok(plans.length > 1);
    for (const plan of plans) assert.equal(plan.demo, demo);
  }
});

void test('统一审核按最新目录刷新身份，忽略候选伪造或旧方案缺失的演示标签', () => {
  const { catalog, requirements } = identityFixture();
  const pc = catalog.prebuilts[0]!;
  const initial = selectPrebuilt(
    pc.id,
    requirements,
    catalog.parts,
    catalog.prebuilts,
  );
  pc.demo = true;
  const audited = auditDelivery(
    [{ ...initial, demo: false }],
    requirements,
    catalog,
  )[0]!;
  assert.equal(audited.demo, true);
  pc.demo = false;
  assert.equal(auditDelivery([audited], requirements, catalog)[0]!.demo, false);

  const current = { ...requirements, mode: 'diy' as const };
  const diy = assembleBuild(
    catalog.parts.map((part) => part.id),
    current,
    catalog.parts,
    catalog.prebuilts,
  );
  const oldPlan = structuredClone(diy);
  delete oldPlan.demo;
  catalog.parts.find((part) => part.category === 'gpu')!.demo = true;
  const refreshed = auditDelivery([oldPlan], current, catalog)[0]!;
  assert.equal(refreshed.demo, true);
  assert.equal(
    refreshed.parts.find((part) => part.category === 'gpu')!.demo,
    true,
  );
  catalog.parts.find((part) => part.category === 'gpu')!.demo = false;
  assert.equal(auditDelivery([refreshed], current, catalog)[0]!.demo, false);
});

void test('目录查询分别保留整机自身与配件身份，不把真实配件演示整机冒充真实商品', async () => {
  const { f, catalog } = identityFixture();
  catalog.prebuilts[0]!.demo = true;
  f.context.reloadCatalog = async () => catalog;
  const prebuilt = await searchCatalogTool.execute(
    { kind: 'prebuilt' },
    f.context,
    f.runtime,
  );
  assert.ok(prebuilt && typeof prebuilt === 'object' && 'matches' in prebuilt);
  assert.ok(Array.isArray(prebuilt.matches));
  assert.equal(prebuilt.matches[0].demo, true);
  assert.ok(
    prebuilt.matches[0].parts.every(
      (part: { demo: boolean }) => part.demo === false,
    ),
  );
  for (const demo of [false, true]) {
    catalog.parts.find((part) => part.category === 'gpu')!.demo = demo;
    const parts = await searchCatalogTool.execute(
      { category: 'gpu' },
      f.context,
      f.runtime,
    );
    assert.ok(parts && typeof parts === 'object' && 'matches' in parts);
    assert.ok(Array.isArray(parts.matches));
    assert.equal(parts.matches[0].demo, demo);
  }
});

void test('选择解释保留最新方案与单件商品身份，知识不可用时也不丢失标签', async () => {
  const { f, catalog, requirements } = identityFixture();
  const pc = catalog.prebuilts[0]!;
  pc.demo = true;
  const plan = selectPrebuilt(
    pc.id,
    requirements,
    catalog.parts,
    catalog.prebuilts,
  );
  f.runtime.draft = requirements;
  f.runtime.result = { requirements, plans: [plan], summary: '身份测试' };
  f.context.reloadCatalog = async () => catalog;
  f.context.embeddingConfig = {};
  for (const demo of [false, true]) {
    catalog.parts.find((part) => part.category === 'gpu')!.demo = demo;
    const explanation = await explainSelectionTool.execute(
      { category: 'gpu' },
      f.context,
      f.runtime,
    );
    assert.ok(
      explanation &&
        typeof explanation === 'object' &&
        'parts' in explanation &&
        'demo' in explanation,
    );
    assert.equal(explanation.demo, true);
    assert.ok(Array.isArray(explanation.parts));
    assert.equal(explanation.parts[0].demo, demo);
    assert.equal(explanation.parts[0].knowledgeStatus, 'unavailable');
  }
});
