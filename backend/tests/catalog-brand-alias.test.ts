import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { matchesModel, searchCatalog } from '../services/catalog-search';

function storageParts() {
  const base = fixture().catalog.parts.find((part) => part.id === 'storage')!;
  return [
    {
      ...structuredClone(base),
      id: 'samsung-1tb',
      brand: 'Samsung 三星',
      name: '990 PRO 1TB',
    },
    {
      ...structuredClone(base),
      id: 'samsung-2tb',
      brand: 'Samsung 三星',
      name: '990 PRO 2TB',
    },
    {
      ...structuredClone(base),
      id: 'other-1tb',
      brand: '其他品牌',
      name: '990 PRO 1TB',
    },
  ];
}

for (const [brand, english, chinese, fragment] of [
  ['Cooler Master 酷冷至尊', 'Cooler Master', '酷冷至尊', 'Master'],
  ['Fractal Design 分形工艺', 'Fractal Design', '分形工艺', 'Design'],
  ['be quiet! 德商必酷', 'be quiet!', '德商必酷', 'quiet!'],
])
  void test(`多词品牌保留完整词组，不制造片段别名：${brand}`, () => {
    const part = { ...storageParts()[0], brand, name: 'Example 1TB' };
    for (const prefix of [brand, english, chinese])
      assert.equal(
        searchCatalog([part], { modelKeyword: `${prefix} Example 1TB` }).length,
        1,
      );
    assert.equal(
      searchCatalog([part], { modelKeyword: `${fragment} Example 1TB` }).length,
      0,
    );
  });

for (const keyword of [
  'Samsung 990 PRO 1TB',
  'Samsung 三星 990 PRO 1TB',
  '三星 990 PRO 1TB',
  'samsung   990 PRO 1TB',
])
  void test(`仅剥当前目录记录的品牌前缀并保留容量：${keyword}`, () => {
    assert.deepEqual(
      searchCatalog(storageParts(), {
        category: 'storage',
        modelKeyword: keyword,
      }).map((part) => part.id),
      ['samsung-1tb'],
    );
  });

void test('显式品牌、颜色、价格仍严格与型号匹配相交', () => {
  const parts = storageParts();
  assert.equal(
    searchCatalog(parts, {
      modelKeyword: 'Samsung 990 PRO 1TB',
      brand: '其他品牌',
    }).length,
    0,
  );
  assert.equal(
    searchCatalog(parts, { modelKeyword: 'Samsung 990 PRO 1TB', color: '白色' })
      .length,
    0,
  );
  assert.equal(
    searchCatalog(parts, { modelKeyword: 'Samsung 990 PRO 1TB', maxPrice: 999 })
      .length,
    0,
  );
  assert.equal(
    searchCatalog(parts, {
      modelKeyword: 'Samsung 990 PRO 1TB',
      minPrice: 1001,
    }).length,
    0,
  );
});

void test('品牌前缀必须有完整空白边界，不吞型号字符或任意外部品牌', () => {
  for (const modelKeyword of [
    'SamsungX 990 PRO 1TB',
    'Samsung990 PRO 1TB',
    '三星级 990 PRO 1TB',
    '未记录品牌 990 PRO 1TB',
  ])
    assert.equal(
      searchCatalog(storageParts(), { modelKeyword }).length,
      0,
      modelKeyword,
    );
  assert.equal(
    searchCatalog(storageParts(), { modelKeyword: 'Samsung 990PRO 1TB' })
      .length,
    0,
  );
  const compact = storageParts().map((part) => ({
    ...part,
    name: part.name.replace('990 PRO', '990PRO'),
  }));
  assert.deepEqual(
    searchCatalog(compact, { modelKeyword: '三星 990PRO 1TB' }).map(
      (part) => part.id,
    ),
    ['samsung-1tb'],
  );
});

void test('纯品牌关键词与原目录拼接可匹配路径不退化', () => {
  for (const modelKeyword of ['Samsung', 'Samsung 三星', '三星', '990 PRO']) {
    const parts = storageParts();
    const before = parts
      .filter((part) =>
        matchesModel(`${part.brand} ${part.name}`, modelKeyword, part.category),
      )
      .map((part) => part.id);
    assert.deepEqual(
      searchCatalog(parts, { modelKeyword }).map((part) => part.id),
      before,
    );
  }
});

void test('原RTX与Ti细分规则不变，新增品牌别名前缀仍用原型号规则', () => {
  const gpu = fixture().catalog.parts.find((part) => part.id === 'gpu')!;
  const parts = [
    {
      ...structuredClone(gpu),
      id: 'base',
      brand: 'MSI 微星',
      name: 'GeForce RTX 5070 12GB',
    },
    {
      ...structuredClone(gpu),
      id: 'ti',
      brand: 'MSI 微星',
      name: 'GeForce RTX 5070 Ti 16GB',
    },
  ];
  for (const modelKeyword of ['RTX 5070', 'MSI RTX 5070', '微星 RTX 5070'])
    assert.deepEqual(
      searchCatalog(parts, { category: 'gpu', modelKeyword }).map(
        (part) => part.id,
      ),
      ['base'],
    );
  assert.deepEqual(
    searchCatalog(parts, {
      category: 'gpu',
      modelKeyword: 'MSI RTX 5070 Ti',
    }).map((part) => part.id),
    ['ti'],
  );
});

void test('Arc型号仍按已记录name匹配，不将Intel推断成ASRock板卡品牌', () => {
  const gpu = fixture().catalog.parts.find((part) => part.id === 'gpu')!;
  const parts = [
    { ...gpu, brand: 'ASRock 华擎', name: 'Intel Arc B570 Challenger 10GB OC' },
  ];
  assert.equal(
    searchCatalog(parts, {
      category: 'gpu',
      modelKeyword: 'Intel Arc B570 Challenger 10GB OC',
    }).length,
    1,
  );
  assert.equal(
    searchCatalog(parts, {
      category: 'gpu',
      modelKeyword: 'Intel B570 Challenger 10GB OC',
    }).length,
    0,
  );
  assert.equal(
    searchCatalog(parts, {
      category: 'gpu',
      modelKeyword: 'Intel Arc B570',
      brand: 'Intel',
    }).length,
    0,
  );
  assert.equal(
    searchCatalog(parts, {
      category: 'gpu',
      modelKeyword: '华擎 Intel Arc B570',
      brand: 'ASRock',
    }).length,
    1,
  );
});
