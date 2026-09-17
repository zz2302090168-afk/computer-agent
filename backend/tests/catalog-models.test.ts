import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { retrieveCatalogModels } from '../rag/catalog-models';

void test('BM25联动召回保留同一目录商品的板卡品牌、型号和ID', () => {
  const f = fixture();
  const gpu = f.catalog.parts.find((p) => p.category === 'gpu')!;
  const storage = f.catalog.parts.find((p) => p.category === 'storage')!;
  Object.assign(gpu, {
    brand: 'ASRock 华擎',
    name: 'Intel Arc B570 Challenger 10GB OC',
  });
  Object.assign(storage, {
    brand: 'Samsung 三星',
    name: '990 PRO 1TB (MZ-V9P1T0BW)',
  });
  const before = structuredClone(f.catalog);
  const result = retrieveCatalogModels(
    f.catalog.parts,
    '显卡Intel Arc B570 Challenger 10GB OC，硬盘Samsung 990 PRO 1TB',
  );
  assert.ok(
    result.some(
      (p) =>
        p.id === gpu.id && p.brand === 'ASRock 华擎' && p.name === gpu.name,
    ),
  );
  assert.ok(
    result.some((p) => p.id === storage.id && p.brand === 'Samsung 三星'),
  );
  assert.deepEqual(f.catalog, before);
  assert.ok(
    retrieveCatalogModels(f.catalog.parts, '华擎').some((p) => p.id === gpu.id),
  );
  assert.deepEqual(retrieveCatalogModels(f.catalog.parts, 'unmatchedxyz'), []);
  assert.deepEqual(retrieveCatalogModels([], 'B570'), []);
  assert.ok(
    !retrieveCatalogModels(
      f.catalog.parts.filter((p) => p.id !== gpu.id),
      'B570',
    ).some((p) => p.id === gpu.id),
  );
});

void test('BM25具体型号优先于共享品牌，大小写与全角输入一致', () => {
  const f = fixture();
  const p = f.catalog.parts[0];
  const parts = [
    { ...p, id: 'other', brand: 'Samsung', name: '980 PRO 250GB' },
    { ...p, id: 'target', brand: 'Samsung', name: '990 PRO 1TB' },
  ];
  assert.equal(
    retrieveCatalogModels(parts, 'Samsung 990 PRO 1TB', 1)[0]?.id,
    'target',
  );
  assert.deepEqual(
    retrieveCatalogModels(parts, 'ＳＡＭＳＵＮＧ ９９０ ＰＲＯ １ＴＢ'),
    retrieveCatalogModels(parts, 'samsung 990 pro 1tb'),
  );
});
