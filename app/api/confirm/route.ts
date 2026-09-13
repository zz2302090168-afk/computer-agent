import { loadCatalog } from '@/backend/db/catalog';
import {
  readPageSession,
  updatePageTask,
} from '@/backend/session/page-session';
import { selectPlan } from '@/backend/services/select-plan';
import { readJson, sessionId, json } from '@/backend/api/http';
import {
  assertPlanActionTask,
  planActionResponse,
} from '@/backend/api/plan-actions';

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
    const { task } = readPageSession(session);
    assertPlanActionTask(input, task);
    const next = selectPlan(
      task,
      input.planId,
      await loadCatalog(),
      { source: 'ui' },
      input.confirm !== false,
    );
    const saved = updatePageTask(session, next, task.version);
    return json(planActionResponse(saved.task));
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '交付审核失败' },
      400,
    );
  }
}
