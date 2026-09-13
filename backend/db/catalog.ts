import { database } from '../../db';
import {
  parts as seedParts,
  prebuilts as seedPcs,
} from '../../data/seed/catalog';
import { monitors as seedMonitors } from '../../data/seed/monitors';
import { enrichInferredSpecs } from '../../data/seed/inferred-specs';
import {
  labels,
  type Monitor,
  type MonitorCatalog,
  type Part,
  type Prebuilt,
} from '../domain/types';
export { database };

export async function loadCatalog(): Promise<{
  parts: Part[];
  prebuilts: Prebuilt[];
}> {
  const db = database();
  // Tables are created only by migrations. Data initialization is idempotent and never overwrites merchant edits.
  const initialized = await db
    .prepare('SELECT value FROM metadata WHERE `key`=?')
    .bind('real-catalog-v2')
    .first();
  if (!initialized) {
    await db.batch([
      db.prepare("DELETE FROM prebuilts WHERE demo=1 AND brand='星构 DEMO'"),
      db.prepare("DELETE FROM products WHERE demo=1 AND brand='星构 DEMO'"),
      ...seedParts.map((p) =>
        db
          .prepare(
            'INSERT IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(
            p.id,
            p.category,
            p.brand,
            p.name,
            p.color,
            p.price,
            JSON.stringify(p.specs),
            p.demo ? 1 : 0,
          ),
      ),
      ...seedPcs.map((p) =>
        db
          .prepare(
            'INSERT IGNORE INTO prebuilts(id,name,brand,color,price,part_ids,demo) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            p.id,
            p.name,
            p.brand,
            p.color,
            p.price,
            JSON.stringify(p.partIds),
            p.demo ? 1 : 0,
          ),
      ),
      db
        .prepare('INSERT IGNORE INTO metadata(`key`,`value`) VALUES(?,?)')
        .bind('real-catalog-v2', 'initialized'),
    ]);
  }
  const [a, b] = await Promise.all([
    db
      .prepare('SELECT * FROM products ORDER BY category,price')
      .all<Omit<Part, 'specs' | 'demo'> & { specs: string; demo: number }>(),
    db
      .prepare('SELECT * FROM prebuilts ORDER BY price')
      .all<
        Omit<Prebuilt, 'partIds' | 'demo'> & { part_ids: string; demo: number }
      >(),
  ]);
  return {
    parts: enrichInferredSpecs(
      a.results.map((p) => ({
        ...p,
        categoryLabel: labels[p.category as keyof typeof labels],
        specs: JSON.parse(p.specs),
        demo: !!p.demo,
      })),
    ),
    prebuilts: b.results.map((p) => ({
      ...p,
      partIds: JSON.parse(p.part_ids),
      demo: !!p.demo,
    })),
  };
}

export async function loadMonitorCatalog(): Promise<MonitorCatalog> {
  try {
    return await readMonitorCatalog();
  } catch (cause) {
    const missingTable =
      cause instanceof Error &&
      'code' in cause &&
      cause.code === 'ER_NO_SUCH_TABLE';
    throw Error(
      missingTable
        ? '显示器数据库尚未初始化，请运行数据库迁移。'
        : '显示器数据库暂时不可用，请稍后重试。',
      { cause },
    );
  }
}

async function readMonitorCatalog(): Promise<MonitorCatalog> {
  const db = database();
  const initialized = await db
    .prepare('SELECT value FROM metadata WHERE `key`=?')
    .bind('monitor-catalog-v1')
    .first();
  if (!initialized) {
    await db.batch([
      ...seedMonitors.map((monitor) =>
        db
          .prepare(
            'INSERT IGNORE INTO monitors(id,brand,name,price,specs,demo) VALUES(?,?,?,?,?,?)',
          )
          .bind(
            monitor.id,
            monitor.brand,
            monitor.name,
            monitor.price,
            JSON.stringify(monitor.specs),
            monitor.demo ? 1 : 0,
          ),
      ),
      db
        .prepare('INSERT IGNORE INTO metadata(`key`,`value`) VALUES(?,?)')
        .bind('monitor-catalog-v1', 'initialized'),
    ]);
  }
  const rows = await db
    .prepare('SELECT * FROM monitors ORDER BY price,id')
    .all<Omit<Monitor, 'specs' | 'demo'> & { specs: string; demo: number }>();
  return {
    monitors: rows.results.map((monitor) => ({
      ...monitor,
      specs: JSON.parse(monitor.specs),
      demo: !!monitor.demo,
    })),
  };
}
