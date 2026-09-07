import { loadCatalog } from '@/backend/db/catalog';
import { ensureWorkspace, saveTask } from '@/backend/db/tasks';
import { executePartReplacement } from '@/backend/tools/build';
import { readJson, sessionId, json } from '@/backend/api/http';
import type { Category, Plan, Requirements } from '@/backend/domain/types';

export async function POST(request: Request) {
  try {
    const input = await readJson(request),
      session = sessionId(request),
      workspace = await ensureWorkspace(session),
      task = workspace.task;
    if (!task.result) throw Error('请先生成配置');
    const plans: Plan[] = task.result.plans,
      plan = plans.find((p) => p.id === input.planId);
    if (!plan) throw Error('方案不存在');
    const { parts } = await loadCatalog(),
      requirements = task.result.requirements as Requirements,
      updated = executePartReplacement(input, plan, requirements, parts),
      next = plans.map((p) => (p.id === updated.id ? updated : p)),
      category = updated.parts.find((p) => p.id === input.newId)?.category as
        | Category
        | undefined;
    const draft = {
        ...task.draft,
        partSelections: {
          ...task.draft.partSelections,
          ...(category ? { [category]: input.newId } : {}),
        },
        partPreferences: {
          ...task.draft.partPreferences,
          ...(category ? { [category]: input.newId } : {}),
        },
        selectionSources: {
          ...task.draft.selectionSources,
          ...(category ? { [category]: 'user' as const } : {}),
        },
      },
      result = {
        ...task.result,
        requirements: { ...requirements, ...draft },
        plans: next,
        summary: '配件已替换，并重新完成预算和兼容性检查。',
      };
    const saved = await saveTask(
      session,
      { ...task, draft, result, issues: [] },
      task.version,
    );
    return json({
      ...result,
      taskId: saved.id,
      version: saved.version,
      event: { type: 'plan', taskId: saved.id, version: saved.version },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : '替换失败' }, 400);
  }
}
