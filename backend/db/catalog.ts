import { database } from '../../db';
import {
  parts as seedParts,
  prebuilts as seedPcs,
} from '../../data/seed/catalog';
import { enrichInferredSpecs } from '../../data/seed/inferred-specs';
import { labels, type Part, type Prebuilt } from '../domain/types';
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
