import { loadCatalog } from '@/backend/db/catalog';
import {
  readPageSession,
  updatePageTask,
} from '@/backend/session/page-session';
import { editPlan } from '@/backend/services/edit-plan';
import { readJson, sessionId, json } from '@/backend/api/http';
import {
  assertPlanActionTask,
  planActionResponse,
} from '@/backend/api/plan-actions';

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
    const { task } = readPageSession(session);
    assertPlanActionTask(input, task);
    const edited = editPlan(
      task,
      input.planId,
      [{ oldId: input.oldId, newId: input.newId }],
      await loadCatalog(),
    );
    const saved = updatePageTask(session, edited, task.version);
    return json(planActionResponse(saved.task));
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '替换失败' },
      400,
    );
  }
}
