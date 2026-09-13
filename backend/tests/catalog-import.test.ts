import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { labels } from '../domain/types';
import {
  buildCatalogImportSql,
  validateCatalogImport,
} from '../services/catalog-import';
import { validateBuild } from '../rules/compatibility';

function catalog() {
  const parts = Object.entries(labels).map(([category, categoryLabel]) => ({
    id: category,
    category,
    brand: '导入测试品牌',
    name: `导入测试${categoryLabel}`,
    color: '黑色',
    price: 1000,
    specs: {},
    demo: false,
  }));
  return {
    parts,
    prebuilts: [
      {
        id: 'test-pc',
        name: '导入测试整机',
        brand: '导入测试商家',
        color: '黑色',
        price: 7500,
        partIds: parts.map((part) => part.id),
        demo: true,
      },
    ],
  };
}

void test('整机导入核对八类完整引用，未知或冲突的 DIY 规格不阻止商家整机入库', () => {
  const imported = validateCatalogImport(catalog());
  assert.equal(validateBuild(imported.parts).status, 'unknown');
  imported.parts.find((part) => part.category === 'cpu')!.specs.socket = 'AM5';
  imported.parts.find((part) => part.category === 'motherboard')!.specs.socket =
    'LGA1700';
  assert.equal(validateBuild(imported.parts).status, 'fail');
  const sql = buildCatalogImportSql(imported);
  assert.equal(
    sql.split('\n').filter((line) => line.startsWith('INSERT INTO products'))
      .length,
    8,
  );
  assert.equal(
    sql.split('\n').filter((line) => line.startsWith('INSERT INTO prebuilts'))
      .length,
    1,
  );
  assert.equal(imported.prebuilts[0]!.price, 7500);
  assert.equal('validation' in imported.prebuilts[0]!, false);
});

void test('整机导入拒绝缺类、重复商品、重复类别和失效引用', () => {
  for (const ids of [
    ['cpu', 'gpu', 'memory', 'motherboard', 'psu', 'case', 'storage'],
    [
      'cpu',
      'gpu',
      'memory',
      'motherboard',
      'psu',
      'case',
      'storage',
      'storage',
    ],
    [
      'cpu',
      'gpu',
      'memory',
      'motherboard',
      'psu',
      'case',
      'storage',
      'missing',
    ],
  ]) {
    const input = catalog();
    input.prebuilts[0]!.partIds = ids;
    assert.throws(
      () => buildCatalogImportSql(input),
      /八类完整|引用的配件不存在/,
    );
  }
  const duplicateCategory = catalog();
  duplicateCategory.parts.find((part) => part.category === 'cooler')!.category =
    'storage';
  assert.throws(() => buildCatalogImportSql(duplicateCategory), /八类完整/);
});

void test('导入拒绝重复 ID、非对象数据和不属于八类的配件', () => {
  const duplicatePart = catalog();
  duplicatePart.parts.push(duplicatePart.parts[0]!);
  assert.throws(() => buildCatalogImportSql(duplicatePart), /配件 ID 重复/);
  const duplicatePc = catalog();
  duplicatePc.prebuilts.push(duplicatePc.prebuilts[0]!);
  assert.throws(() => buildCatalogImportSql(duplicatePc), /整机 ID 重复/);
  for (const input of [
    null,
    [],
    { parts: [], prebuilts: null },
    { parts: [null], prebuilts: [] },
  ])
    assert.throws(
      () => buildCatalogImportSql(input),
      /必须是对象|需要 parts 和 prebuilts 数组/,
    );
  for (const category of ['monitor', 'constructor', '__proto__', 1]) {
    const input = catalog();
    assert.throws(
      () =>
        buildCatalogImportSql({
          ...input,
          parts: [{ ...input.parts[0], category }, ...input.parts.slice(1)],
        }),
      /类别无效/,
    );
  }
});

void test('导入字段遵守数据库文本长度、价格范围与明确的演示布尔标记', () => {
  const invalid: [string, unknown][] = [
    ['id', 42],
    ['id', 'x'.repeat(192)],
    ['name', ' '],
    ['name', 'x'.repeat(256)],
    ['name', '\ud800'],
    ['brand', {}],
    ['brand', 'x'.repeat(192)],
    ['color', 'x'.repeat(33)],
    ['price', '1000'],
    ['price', -1],
    ['price', 0.5],
    ['price', Infinity],
    ['price', NaN],
    ['price', 2147483648],
    ['demo', undefined],
    ['demo', 0],
    ['demo', 'false'],
  ];
  for (const [field, value] of invalid) {
    const input = catalog();
    assert.throws(
      () =>
        buildCatalogImportSql({
          ...input,
          parts: [
            { ...input.parts[0], [field]: value },
            ...input.parts.slice(1),
          ],
        }),
      `配件 ${field}=${String(value)}`,
    );
    assert.throws(
      () =>
        buildCatalogImportSql({
          ...input,
          prebuilts: [{ ...input.prebuilts[0], [field]: value }],
        }),
      `整机 ${field}=${String(value)}`,
    );
  }
  for (const specs of [null, [], '规格', { note: 'x'.repeat(65536) }]) {
    const input = catalog();
    assert.throws(
      () =>
        buildCatalogImportSql({
          ...input,
          parts: [{ ...input.parts[0], specs }, ...input.parts.slice(1)],
        }),
      /规格/,
    );
  }
  const boundaries = catalog();
  boundaries.parts[0]!.price = 0;
  boundaries.parts[0]!.name = '😀'.repeat(255);
  boundaries.prebuilts[0]!.price = 2147483647;
  assert.doesNotThrow(() => buildCatalogImportSql(boundaries));
});

void test('SQL 文字完整保留反斜杠、引号、控制字符、中文和 emoji', () => {
  const input = catalog();
  const special =
    "中文😀 C:\\new\\test O'Brien \\'; DROP TABLE products; -- \u0000\n\r\t\u001a";
  input.parts[0]!.name = special;
  input.parts[0]!.specs = { note: special };
  input.prebuilts[0]!.name = special;
  const sql = buildCatalogImportSql(input);
  const strings = [
    ...sql.matchAll(/CONVERT\(X'([0-9a-f]*)' USING utf8mb4\)/g),
  ].map((match) => Buffer.from(match[1]!, 'hex').toString('utf8'));
  assert.equal(strings.filter((value) => value === special).length, 2);
  assert.ok(strings.includes(JSON.stringify({ note: special })));
  assert.ok(strings.includes(JSON.stringify(input.prebuilts[0]!.partIds)));
  assert.equal(sql.includes('DROP TABLE'), false);
  assert.match(
    sql,
    /^START TRANSACTION;\nDELETE FROM prebuilts;\nDELETE FROM products;/,
  );
  assert.ok(sql.endsWith('\nCOMMIT;'));
});

void test('导入命令仅生成 SQL，校验失败不覆盖已生成文件', async () => {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'catalog-import-test-'));
  try {
    await mkdir(join(directory, 'data'));
    const file = join(directory, 'catalog.json');
    const output = join(directory, 'data', 'merchant-import.sql');
    const script = fileURLToPath(
      new URL('../../scripts/prepare-import.mjs', import.meta.url),
    );
    await writeFile(file, JSON.stringify(catalog()));
    const run = () =>
      spawnSync(
        process.execPath,
        ['--experimental-strip-types', script, file],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 10000,
        },
      );
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /尚未执行/);
    assert.match(valid.stdout, /请先备份数据库/);
    const original = await readFile(output, 'utf8');
    await writeFile(
      file,
      JSON.stringify({ parts: [], prebuilts: catalog().prebuilts }),
    );
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /引用的配件不存在/);
    assert.equal(await readFile(output, 'utf8'), original);
  } finally {
    const child = relative(tempRoot, directory);
    assert.ok(child.startsWith('catalog-import-test-') && !child.includes(sep));
    await rm(directory, { recursive: true, force: true });
  }
});
