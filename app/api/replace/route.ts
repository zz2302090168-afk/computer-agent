import { loadCatalog, database } from '@/backend/db/catalog';
import { replacePart } from '@/backend/services/recommend';
import { readJson, sessionId, json } from '@/backend/api/http';
import type { Plan } from '@/backend/domain/types';
export async function POST(request: Request) {
  try {
    const input = await readJson(request),
      id = sessionId(request),
      db = database();
    const row = await db
      .prepare('SELECT requirements,plans FROM sessions WHERE id=?')
      .bind(id)
      .first<{requirements:string;plans:string}>();
    if (!row) throw Error('请先生成配置');
    const plans: Plan[] = JSON.parse(row.plans),
      requirements = JSON.parse(row.requirements),
      plan = plans.find((p) => p.id === input.planId);
    if (!plan) throw Error('方案不存在');
    const { parts } = await loadCatalog();
    const updated = replacePart(
      plan,
      input.oldId,
      input.newId,
      requirements,
      parts,
    );
    const next = plans.map((p) => (p.id === updated.id ? updated : p));
    await db
      .prepare('UPDATE sessions SET plans=?,updated_at=? WHERE id=?')
      .bind(JSON.stringify(next), Date.now(), id)
      .run();
    return json({
      requirements,
      plans: next,
      summary: '配件已替换，并重新通过预算和兼容性检查。',
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '替换失败' }, 400);
  }
}
