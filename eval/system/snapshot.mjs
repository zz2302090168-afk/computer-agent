import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { parse } from 'dotenv';
import { labels } from '../../backend/domain/types.ts';
import { enrichInferredSpecs } from '../../data/seed/inferred-specs.ts';
import { knowledge } from '../../knowledge/library.ts';

const settings = {
  ...parse(
    readFileSync(
      process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
    ),
  ),
  ...process.env,
};
const directory = `eval/results/system-${new Date().toISOString().replaceAll(':', '-')}`;
mkdirSync(directory, { recursive: true });
const save = (name, value) =>
  writeFileSync(`${directory}/${name}`, JSON.stringify(value, null, 2));
const hash = (value) => createHash('sha256').update(value).digest('hex');
let connection;
try {
  connection = await mysql.createConnection(settings.DATABASE_URL);
  await connection.query('START TRANSACTION READ ONLY');
  const [metadata] = await connection.query('SELECT `key`,value FROM metadata');
  const [parts] = await connection.query(
    'SELECT id,category,brand,name,color,price,specs,demo FROM products ORDER BY id',
  );
  const [prebuilts] = await connection.query(
    'SELECT id,name,brand,color,price,part_ids,demo FROM prebuilts ORDER BY id',
  );
  const [monitors] = await connection.query(
    'SELECT id,brand,name,price,specs,demo FROM monitors ORDER BY id',
  );
  const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const catalog = {
    parts: enrichInferredSpecs(
      parts.map((p) => ({
        ...p,
        price: Number(p.price),
        specs: json(p.specs),
        demo: !!p.demo,
        categoryLabel: labels[p.category],
      })),
    ),
    prebuilts: prebuilts.map(({ part_ids, ...p }) => ({
      ...p,
      price: Number(p.price),
      partIds: json(part_ids),
      demo: !!p.demo,
    })),
  };
  save('catalog.json', catalog);
  save(
    'monitors.json',
    monitors.map((p) => ({
      ...p,
      price: Number(p.price),
      specs: json(p.specs),
      demo: !!p.demo,
    })),
  );
  save('knowledge.json', knowledge);
  const sourceHashes = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|md|json)$/.test(path))
        sourceHashes[path] = hash(readFileSync(path));
    }
  };
  for (const dir of [
    'backend',
    'frontend',
    'app',
    'knowledge',
    'db',
    'data/seed',
    'eval/system',
  ])
    walk(dir);
  save('manifest.json', {
    createdAt: new Date().toISOString(),
    phase: 'P0',
    catalogSource:
      'MySQL read-only transaction; same inferred-spec enrichment as production',
    counts: {
      parts: catalog.parts.length,
      prebuilts: catalog.prebuilts.length,
      monitors: monitors.length,
      knowledge: knowledge.length,
    },
    initialized: metadata
      .filter((r) => ['real-catalog-v2', 'monitor-catalog-v1'].includes(r.key))
      .map((r) => r.key),
    model: settings.MODEL_NAME,
    embeddingModel: settings.EMBEDDING_MODEL,
    catalogHash: hash(JSON.stringify(catalog)),
    knowledgeHash: hash(JSON.stringify(knowledge)),
    sourceHashes,
    semantics:
      'page conversation remains in memory; these files are isolated evaluation fixtures, not recovery state',
  });
  console.log(
    JSON.stringify({
      directory,
      counts: {
        parts: catalog.parts.length,
        prebuilts: catalog.prebuilts.length,
        monitors: monitors.length,
      },
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'failed',
      type: error.name,
      code: error.code ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  if (connection) {
    await connection.rollback();
    await connection.end();
  }
}
