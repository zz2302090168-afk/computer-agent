import { loadCatalog } from '@/backend/db/catalog';
import { ensureWorkspace, saveTask } from '@/backend/db/tasks';
import { selectPlan } from '@/backend/services/select-plan';
import { readJson, sessionId, json } from '@/backend/api/http';

// 与聊天select_plan使用同一选择服务；不下单或付款。
export async function POST(request: Request) {
  try {
    const input = await readJson(request);
    if (
      typeof input.planId !== 'string' ||
      (input.confirm !== undefined && typeof input.confirm !== 'boolean')
    )
      throw Error('选择方案参数无效');
    const session = sessionId(request);
    const { task } = await ensureWorkspace(session);
    if (input.taskId !== undefined && input.taskId !== task.id)
      throw Error('当前任务已切换，请刷新后重试');
    const next = selectPlan(
      task,
      input.planId,
      await loadCatalog(),
      { source: 'ui' },
      input.confirm !== false,
    );
    const saved = await saveTask(session, next, task.version);
    return json({ ...saved.result, taskId: saved.id, version: saved.version });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '交付审核失败' },
      400,
    );
  }
}
