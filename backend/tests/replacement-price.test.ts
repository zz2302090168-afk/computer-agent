import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { executeRegisteredTool } from '../tools/registry';
import { findReplacements } from '../services/find-replacements';
import { replacementPreviewReply } from '../agent/sales-reply';

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

void test('单件更便宜严格低于原价，排序不能替代过滤，查询不改方案', async () => {
  const f = fixture();
  const old = f.catalog.parts.find((part) => part.id === 'gpu')!;
  f.catalog.parts.push({
    ...structuredClone(old),
    id: 'gpu-same',
    name: 'gpu-same',
  });
  const before = structuredClone({
    draft: f.runtime.draft,
    result: f.runtime.result,
  });
  const { data } = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    priceRelation: 'cheaper',
    sort: 'price_desc',
    limit: 20,
  });
  assert.ok(data.candidates.length);
  assert.ok(
    data.candidates.every((candidate) => candidate.parts[0].price < old.price),
  );
  assert.equal(data.categories[0].oldPrice, 1000);
  assert.equal(data.categories[0].priceRelation, 'cheaper');
  assert.ok(
    !data.candidates.some((candidate) => candidate.parts[0].id === 'gpu-same'),
  );
  assert.deepEqual(
    { draft: f.runtime.draft, result: f.runtime.result },
    before,
  );
  assert.equal(f.saved.length, 0);
  const broad = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    sort: 'price_asc',
    limit: 20,
  });
  assert.ok(
    broad.data.candidates.some(
      (candidate) => candidate.parts[0].price >= old.price,
    ),
  );
});

void test('单件价格关系跨轮继承，可显式取消，换方案重新锚定原价且不盲继承', async () => {
  const f = fixture();
  const first = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    priceRelation: 'cheaper',
  });
  remember(f, first.output);
  const inherited = await query(f, { planId: 'plan-1', category: 'gpu' });
  assert.equal(inherited.data.query[0].priceRelation, 'cheaper');
  assert.ok(
    inherited.data.candidates.every(
      (candidate) => candidate.parts[0].price < 1000,
    ),
  );
  const cancelled = await query(f, {
    planId: 'plan-1',
    category: 'gpu',
    priceRelation: 'any',
  });
  assert.ok(
    cancelled.data.candidates.some(
      (candidate) => candidate.parts[0].price >= 1000,
    ),
  );
  const changed = await query(f, { planId: 'plan-2', category: 'gpu' });
  assert.equal(changed.data.query[0].priceRelation, undefined);
  assert.equal(changed.data.categories[0].oldPrice, 1050);
  const newAnchor = await query(f, {
    planId: 'plan-2',
    category: 'gpu',
    priceRelation: 'cheaper',
  });
  assert.ok(
    newAnchor.data.candidates.some(
      (candidate) => candidate.parts[0].price === 1000,
    ),
  );
  assert.ok(
    newAnchor.data.candidates.every(
      (candidate) => candidate.parts[0].price < 1050,
    ),
  );
});

function combinedFixture() {
  const f = fixture();
  f.catalog.parts = f.catalog.parts.filter((part) => part.id === part.category);
  const cpu = f.catalog.parts.find((part) => part.id === 'cpu')!;
  const gpu = f.catalog.parts.find((part) => part.id === 'gpu')!;
  f.catalog.parts.find(
    (part) => part.id === 'motherboard',
  )!.specs.supportedCpus = ['cpu', 'cpu-plus'];
  f.catalog.parts.push({
    ...structuredClone(cpu),
    id: 'cpu-plus',
    name: 'cpu-plus',
    price: 1020,
  });
  for (const price of [950, 980, 1030])
    f.catalog.parts.push({
      ...structuredClone(gpu),
      id: `gpu-${price}`,
      name: `gpu-${price}`,
      price,
    });
  return f;
}

void test('组合关系依据重新审核后的实际八件总价，包含未替换件的目录调价', async () => {
  const rising = combinedFixture();
  rising.catalog.parts.find((part) => part.id === 'memory')!.price = 1030;
  const queryArgs = {
    planId: 'plan-1',
    items: [{ category: 'cpu' }, { category: 'gpu' }],
    totalPriceRelation: 'cheaper',
    limit: 20,
  };
  const higher = await query(rising, queryArgs);
  assert.equal(higher.data.oldTotal, 8000);
  assert.equal(higher.data.candidates.length, 0);
  assert.ok(
    higher.data.rejected.some((candidate) =>
      candidate.reason.includes('没有严格低于'),
    ),
  );
  const falling = combinedFixture();
  falling.catalog.parts.find((part) => part.id === 'memory')!.price = 900;
  const lower = await query(falling, queryArgs);
  assert.ok(
    lower.data.candidates.some(
      (candidate) =>
        candidate.total === 7950 &&
        candidate.parts.some((part) => part.id === 'gpu-1030'),
    ),
  );
  assert.ok(lower.data.candidates.every((candidate) => candidate.total < 8000));
  assert.equal(rising.saved.length + falling.saved.length, 0);
});

void test('组合更便宜允许一涨一降；同价排除，原始分页不跨页扫描凑数', async () => {
  const f = combinedFixture();
  const args = {
    planId: 'plan-1',
    items: [{ category: 'cpu' }, { category: 'gpu' }],
    totalPriceRelation: 'cheaper',
    sort: 'price_desc',
    limit: 1,
  };
  const first = await query(f, args);
  assert.equal(first.data.matchCount, 3);
  assert.equal(first.data.candidates.length, 0);
  assert.equal(first.data.rejected.length, 1);
  assert.equal(first.data.nextOffset, 1);
  assert.match(replacementPreviewReply(first.data), /后续待审核组合/);
  const equal = await query(f, { ...args, offset: 1 });
  assert.equal(equal.data.candidates.length, 0);
  assert.match(equal.data.rejected[0].reason, /没有严格低于/);
  assert.equal(equal.data.nextOffset, 2);
  const lower = await query(f, { ...args, offset: 2 });
  assert.equal(lower.data.candidates.length, 1);
  assert.equal(lower.data.candidates[0].total, 7970);
  assert.equal(lower.data.candidates[0].difference, -30);
  assert.equal(lower.data.nextOffset, null);
  assert.equal(lower.data.oldTotal, 8000);
  const every = await query(f, {
    planId: 'plan-1',
    items: [
      { category: 'cpu', priceRelation: 'cheaper' },
      { category: 'gpu', priceRelation: 'cheaper' },
    ],
    totalPriceRelation: 'cheaper',
  });
  assert.equal(every.data.matchCount, 0);
  assert.equal(every.data.candidates.length, 0);
  assert.equal(f.saved.length, 0);
});

void test('组合价格关系仅在同方案同类别集合继承，重排保留，增减类别不继承，可取消', async () => {
  const f = combinedFixture();
  const first = await query(f, {
    planId: 'plan-1',
    items: [{ category: 'cpu' }, { category: 'gpu' }],
    totalPriceRelation: 'cheaper',
  });
  remember(f, first.output);
  const inherited = await query(f, {
    planId: 'plan-1',
    items: [{ category: 'gpu' }, { category: 'cpu' }],
  });
  assert.equal(inherited.data.totalPriceRelation, 'cheaper');
  assert.ok(
    inherited.data.candidates.every((candidate) => candidate.total < 8000),
  );
  const reduced = await query(f, { planId: 'plan-1', category: 'gpu' });
  assert.equal(reduced.data.totalPriceRelation, 'any');
  const expanded = await query(f, {
    planId: 'plan-1',
    items: [{ category: 'cpu' }, { category: 'gpu' }, { category: 'storage' }],
  });
  assert.equal(expanded.data.totalPriceRelation, 'any');
  const cancelled = await query(f, {
    planId: 'plan-1',
    items: [{ category: 'cpu' }, { category: 'gpu' }],
    totalPriceRelation: 'any',
  });
  assert.ok(
    cancelled.data.candidates.some((candidate) => candidate.total >= 8000),
  );
});

for (const args of [
  { category: 'gpu', priceRelation: 'same' },
  { category: 'gpu', totalPriceRelation: 1 },
])
  void test(`无效价格关系拒绝且不改变方案：${JSON.stringify(args)}`, async () => {
    const f = fixture();
    const before = structuredClone(f.runtime.result);
    const output = await executeRegisteredTool(
      'find_replacements',
      { ...args, planId: 'plan-1' },
      f.context,
      f.runtime,
    );
    assert.equal(output.operation.failed, true);
    assert.deepEqual(f.runtime.result, before);
  });
