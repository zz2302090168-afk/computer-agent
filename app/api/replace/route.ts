import { loadCatalog } from '@/backend/db/catalog';
import { ensureWorkspace, saveTask } from '@/backend/db/tasks';
import { editPlan } from '@/backend/services/edit-plan';
import { readJson, sessionId, json } from '@/backend/api/http';

export async function POST(request: Request) {
  try {
    const input = await readJson(request),
      session = sessionId(request);
    if (
      typeof input.taskId !== 'string' ||
      !input.taskId.trim() ||
      typeof input.planId !== 'string' ||
      typeof input.oldId !== 'string' ||
      typeof input.newId !== 'string'
    )
      throw Error('替换参数无效');
    const { task } = await ensureWorkspace(session);
    if (input.taskId !== task.id) throw Error('当前任务已切换，请刷新后重试');
    const edited = editPlan(
      task,
      input.planId,
      [{ oldId: input.oldId, newId: input.newId }],
      await loadCatalog(),
    );
    const saved = await saveTask(session, edited, task.version);
    return json({ ...saved.result, taskId: saved.id, version: saved.version });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '替换失败' },
      400,
    );
  }
}
