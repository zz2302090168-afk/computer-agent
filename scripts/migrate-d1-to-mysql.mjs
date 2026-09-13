import dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, globSync } from 'node:fs';
import mysql from 'mysql2/promise';

dotenv.config({ path: '.env.local', quiet: true });

const explicitSource = process.argv[2];
const candidates = explicitSource
  ? [explicitSource]
  : globSync(
      '.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite',
    ).filter((path) => !path.endsWith('metadata.sqlite'));

if (candidates.length !== 1 || !existsSync(candidates[0]))
  throw Error(
    '未找到唯一的旧 D1 数据文件，请把 sqlite 文件路径作为命令参数传入。',
  );

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl || !/^mysql:\/\//i.test(databaseUrl))
  throw Error('请先在 .env.local 配置 MySQL DATABASE_URL。');

const source = new DatabaseSync(candidates[0], { readOnly: true });
const target = await mysql.createConnection(databaseUrl);
const tableOrder = ['products', 'prebuilts', 'metadata'];
const sourceTables = new Set(
  source
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name),
);
const imported = {};

try {
  await target.beginTransaction();
  for (const table of tableOrder) {
    if (!sourceTables.has(table)) continue;
    const rows = source.prepare(`SELECT * FROM \`${table}\``).all();
    imported[table] = rows.length;
    for (const row of rows) {
      const columns = Object.keys(row);
      const names = columns.map((name) => `\`${name}\``).join(',');
      const placeholders = columns.map(() => '?').join(',');
      const updates = columns
        .filter((name) => name !== 'id' && name !== 'key')
        .map((name) => `\`${name}\`=VALUES(\`${name}\`)`)
        .join(',');
      const duplicate = updates ? ` ON DUPLICATE KEY UPDATE ${updates}` : '';
      await target.execute(
        `INSERT INTO \`${table}\` (${names}) VALUES (${placeholders})${duplicate}`,
        columns.map((name) => row[name]),
      );
    }
  }
  await target.commit();
  console.log('D1 数据已迁移到 MySQL：' + JSON.stringify(imported));
} catch (cause) {
  await target.rollback();
  throw cause;
} finally {
  source.close();
  await target.end();
}
