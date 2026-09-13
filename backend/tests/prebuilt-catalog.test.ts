import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPrebuilts,
  indexPrebuilts,
} from '../../frontend/prebuilt-catalog-data';
import { fixture } from './pc-fixture';
import type { Catalog, Prebuilt } from '../domain/types';

function catalogFixture(): Catalog {
  const f = fixture();
  const parts = f.catalog.parts.map((part) => ({ ...part, demo: false }));
  const product: Prebuilt = {
    id: 'pc-a',
    name: '黑色入门整机',
    brand: '整机品牌甲',
    color: '黑色',
    price: 3500,
    demo: false,
    partIds: f.runtime.result!.plans[1]!.parts.map((part) => part.id),
  };
  return {
    parts,
    prebuilts: [
      product,
      {
        ...product,
        id: 'pc-b',
        name: '白色整机',
        brand: '整机品牌乙',
        color: '白色',
        price: 5500,
        demo: true,
      },
    ],
  };
}
const all = { query: '', brand: '', color: '', sort: 'catalog' };

void test('整机目录按关联CPU和显卡搜索，以整机售价筛选排序并保留演示商品', () => {
  const catalog = catalogFixture();
  const items = indexPrebuilts(catalog);
  assert.equal(filterPrebuilts(items, all).length, 2);
  assert.equal(
    filterPrebuilts(items, { ...all, query: '测试CPU 测试GPU' }).length,
    2,
  );
  assert.deepEqual(
    filterPrebuilts(items, {
      ...all,
      query: '整机品牌甲',
      minPrice: 3500,
      maxPrice: 3500,
    }).map((item) => item.product.id),
    ['pc-a'],
  );
  assert.deepEqual(
    filterPrebuilts(items, { ...all, color: '白色', brand: '整机品牌乙' }).map(
      (item) => item.product.id,
    ),
    ['pc-b'],
  );
  assert.deepEqual(
    filterPrebuilts(items, { ...all, sort: 'price-desc' }).map(
      (item) => item.product.price,
    ),
    [5500, 3500],
  );
  assert.deepEqual(
    items.map((item) => item.product.id),
    ['pc-a', 'pc-b'],
  );
});

void test('整机自身或任一部件为演示时标为演示，缺失部件不补造', () => {
  const catalog = catalogFixture();
  const original = indexPrebuilts(catalog);
  assert.equal(original[0]!.demo, false);
  assert.equal(original[1]!.demo, true);
  catalog.parts.find((part) => part.id === 'gpu')!.demo = true;
  catalog.prebuilts[0]!.partIds = catalog.prebuilts[0]!.partIds.map((id) =>
    id === 'cooler' ? 'missing-cooler' : id,
  );
  const indexed = indexPrebuilts(catalog)[0]!;
  assert.equal(indexed.demo, true);
  assert.deepEqual(indexed.missingPartIds, ['missing-cooler']);
  assert.equal(indexed.parts.length, 7);
  assert.equal(
    indexed.parts.some((part) => part.category === 'cooler'),
    false,
  );
  assert.equal(indexed.product.price, 3500);
});
