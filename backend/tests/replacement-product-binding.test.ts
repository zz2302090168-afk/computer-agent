import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import type { findReplacements } from '../services/find-replacements';

async function query(f: ReturnType<typeof fixture>, args: unknown) {
  const output = await executeRegisteredTool(
    'find_replacements',
    args,
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, false);
  assert.ok('data' in output);
  return { output, data: output.data as ReturnType<typeof findReplacements> };
}

function remember(f: ReturnType<typeof fixture>, output: unknown) {
  f.context.messages.push({
    role: 'assistant',
    taskId: 'task',
    content: '已查询',
    replacementQueries: [
      { role: 'tool', tool_call_id: 'query', content: JSON.stringify(output) },
    ],
  });
}

void test('先查目录取得精确ID，再以不同品牌与型号字段的商品作组合预览', async () => {
  const f = fixture();
  const gpu = f.catalog.parts.find((part) => part.id === 'gpu-cheaper')!;
  Object.assign(gpu, {
    brand: 'ASRock 华擎',
    name: 'Intel Arc B570 Challenger 10GB OC',
    demo: false,
  });
  const storage = f.catalog.parts.find(
    (part) => part.id === 'storage-cheaper',
  )!;
  Object.assign(storage, {
    brand: 'Samsung',
    name: '990 PRO 1TB',
    price: 1020,
  });
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  const gpuSearch = await executeRegisteredTool(
    'search_catalog',
    { category: 'gpu', modelKeyword: 'Intel Arc B570' },
    f.context,
    f.runtime,
  );
  const storageSearch = await executeRegisteredTool(
    'search_catalog',
    { category: 'storage', brand: 'Samsung', modelKeyword: '990 PRO 1TB' },
    f.context,
    f.runtime,
  );
  assert.equal(gpuSearch.operation.failed, false);
  assert.equal(storageSearch.operation.failed, false);
  assert.ok('data' in gpuSearch && 'data' in storageSearch);
  const gpuMatch = (gpuSearch.data as { matches: { id: string }[] }).matches[0];
  const storageMatch = (storageSearch.data as { matches: { id: string }[] })
    .matches[0];
  const { data } = await query(f, {
    planId: 'plan-1',
    items: [
      {
        category: 'gpu',
        productId: gpuMatch.id,
        brand: 'ASRock',
        modelKeyword: 'Intel Arc B570',
      },
      {
        category: 'storage',
        productId: storageMatch.id,
        brand: 'Samsung',
        modelKeyword: '990 PRO 1TB',
      },
    ],
    totalPriceRelation: 'cheaper',
  });
  assert.equal(data.matchCount, 1);
  assert.equal(data.candidates.length, 1);
  assert.equal(data.candidates[0].total, 7970);
  assert.equal(data.candidates[0].difference, -30);
  assert.deepEqual(
    data.candidates[0].parts.map((part) => [part.id, part.demo]),
    [
      [gpu.id, false],
      [storage.id, true],
    ],
  );
  assert.equal(data.preservedProductIds.length, 6);
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
  assert.equal(f.saved.length, 0);
});

for (const productId of ['missing-product', 'storage-cheaper', '   '])
  void test(`未知或错类别精确ID不回退到其他商品：${productId}`, async () => {
    const f = fixture();
    const before = structuredClone(f.runtime.result);
    const output = await executeRegisteredTool(
      'find_replacements',
      { planId: 'plan-1', category: 'gpu', productId },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true);
    assert.deepEqual(f.runtime.result, before);
    assert.equal(f.saved.length, 0);
  });

for (const extra of [
  { brand: '其他品牌' },
  { modelKeyword: '不存在的型号' },
  { color: '白色' },
  { priceRelation: 'cheaper', productId: 'gpu-upper' },
])
  void test(`精确ID不能绕过同时提供的约束：${JSON.stringify(extra)}`, async () => {
    const f = fixture();
    const { data } = await query(f, {
      planId: 'plan-1',
      category: 'gpu',
      productId: 'gpu-cheaper',
      ...extra,
    });
    assert.equal(data.matchCount, 0);
    assert.equal(data.candidates.length, 0);
    assert.equal(f.saved.length, 0);
  });

void test('与原件相同的ID不是替换候选；绑定ID仍须兼容审核', async () => {
  const f = fixture();
  const same = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu',
  });
  assert.equal(same.data.candidates.length, 0);
  const invalid = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu-too-long',
  });
  assert.equal(invalid.data.matchCount, 1);
  assert.equal(invalid.data.candidates.length, 0);
  assert.equal(invalid.data.rejected.length, 1);
  assert.match(invalid.data.rejected[0].reason, /显卡|长度|兼容/);
  assert.equal(f.saved.length, 0);
});

void test('同方案同类别续查继承ID，显式取消或新型号/品牌查询不沿旧ID，换方案不继承', async () => {
  const f = fixture();
  const first = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu-cheaper',
  });
  remember(f, first.output);
  const continued = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    offset: 1,
  });
  assert.equal(continued.data.query[0].productId, 'gpu-cheaper');
  assert.equal(continued.data.candidates.length, 0);
  const newModel = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    modelKeyword: 'gpu-upper',
  });
  assert.equal(newModel.data.query[0].productId, undefined);
  assert.equal(newModel.data.candidates[0]?.parts[0].id, 'gpu-upper');
  const newBrand = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    brand: '测试品牌',
  });
  assert.equal(newBrand.data.query[0].productId, undefined);
  assert.ok(newBrand.data.matchCount > 1);
  const cleared = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: '',
  });
  assert.equal(cleared.data.query[0].productId, '');
  assert.ok(cleared.data.matchCount > 1);
  const changedPlan = await query(f, { planId: 'plan-2', category: 'gpu' });
  assert.equal(changedPlan.data.query[0].productId, undefined);
});

void test('新精确ID不会清掉旧品牌/型号约束，冲突仍为空', async () => {
  const f = fixture();
  const first = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu-cheaper',
    modelKeyword: 'gpu-cheaper',
    brand: '测试品牌',
    priceRelation: 'cheaper',
  });
  remember(f, first.output);
  const next = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu-upper',
  });
  assert.equal(next.data.query[0].modelKeyword, 'gpu-cheaper');
  assert.equal(next.data.query[0].brand, '测试品牌');
  assert.equal(next.data.query[0].priceRelation, 'cheaper');
  assert.equal(next.data.candidates.length, 0);
});

void test('刷新目录删除已绑定商品时，失败且不回退到其他候选', async () => {
  const f = fixture();
  const first = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    productId: 'gpu-cheaper',
  });
  remember(f, first.output);
  f.catalog.parts = f.catalog.parts.filter((part) => part.id !== 'gpu-cheaper');
  const output = await executeRegisteredTool(
    'find_replacements',
    { planId: 'plan-1', category: 'gpu' },
    f.context,
    f.runtime,
  );
  assert.equal(output.operation.failed, true);
  assert.match(output.operation.error ?? '', /不在当前目录/);
  assert.equal(f.saved.length, 0);
});
