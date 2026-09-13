// Validate a complete merchant catalog and produce a transaction for MySQL import.
import './register-typescript.mjs';
import { readFile, writeFile } from 'node:fs/promises';
const { buildCatalogImportSql } =
  await import('../backend/services/catalog-import.ts');
const file = process.argv[2];
if (!file)
  throw Error(
    '用法: node scripts/prepare-import.mjs <包含 parts 和 prebuilts 的 JSON>',
  );
const sql = buildCatalogImportSql(JSON.parse(await readFile(file, 'utf8')));
await writeFile('data/merchant-import.sql', sql);
console.log(
  '已生成 data/merchant-import.sql，将替换配件与整机目录；已有方案会在下次读取时重新审核。尚未执行，请先备份数据库。',
);
