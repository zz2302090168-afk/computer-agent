// Validate a complete merchant catalog and produce a transaction for local D1 import.
import './register-typescript.mjs';
import { readFile, writeFile } from 'node:fs/promises';
const { validateBuild } = await import('../backend/rules/compatibility.ts');
const { labels } = await import('../backend/domain/types.ts');
const file = process.argv[2];
if (!file)
  throw Error(
    '用法: node scripts/prepare-import.mjs <包含 parts 和 prebuilts 的 JSON>',
  );
const { parts, prebuilts } = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(parts) || !Array.isArray(prebuilts))
  throw Error('需要 parts 和 prebuilts 数组');
const ids = new Set();
for (const p of parts) {
  if (
    ids.has(p.id) ||
    !p.id ||
    !labels[p.category] ||
    !Number.isInteger(p.price) ||
    p.price < 0 ||
    !p.brand ||
    !p.name ||
    !p.color ||
    !p.specs
  )
    throw Error('商品字段不完整或重复: ' + p.id);
  ids.add(p.id);
}
const pcIds = new Set();
for (const pc of prebuilts) {
  if (
    pcIds.has(pc.id) ||
    !pc.id ||
    !pc.name ||
    !pc.brand ||
    !pc.color ||
    !Number.isInteger(pc.price) ||
    pc.price < 0 ||
    !Array.isArray(pc.partIds) ||
    pc.partIds.some((id) => !ids.has(id))
  )
    throw Error('整机字段无效或引用缺失');
  pcIds.add(pc.id);
  const v = validateBuild(
    pc.partIds.map((id) => parts.find((p) => p.id === id)),
  );
  if (v.status !== 'pass') throw Error(pc.id + ': ' + v.issues.join(';'));
}
const q = (x) => "'" + String(x).replaceAll("'", "''") + "'";
const sql = [
  'BEGIN TRANSACTION;',
  'DELETE FROM sessions;',
  'DELETE FROM prebuilts;',
  'DELETE FROM products;',
  ...parts.map(
    (p) =>
      `INSERT INTO products(id,category,brand,name,color,price,specs,demo) VALUES(${[p.id, p.category, p.brand, p.name, p.color, p.price, JSON.stringify(p.specs), p.demo ? 1 : 0].map(q).join(',')});`,
  ),
  ...prebuilts.map(
    (p) =>
      `INSERT INTO prebuilts(id,name,brand,color,price,part_ids,demo) VALUES(${[p.id, p.name, p.brand, p.color, p.price, JSON.stringify(p.partIds), p.demo ? 1 : 0].map(q).join(',')});`,
  ),
  "INSERT OR REPLACE INTO metadata(key,value) VALUES('seed-v1','merchant-import');",
  'COMMIT;',
];
await writeFile('data/merchant-import.sql', sql.join('\n'));
console.log(
  '已生成 data/merchant-import.sql，尚未执行。该导入替换目录并清除旧方案，请先备份数据库。',
);
