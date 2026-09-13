import { json, readJson, sessionId } from '@/backend/api/http';
import { loadCatalog, loadMonitorCatalog } from '@/backend/db/catalog';
import {
  readPageSession,
  updatePageTask,
} from '@/backend/session/page-session';
import { completeRequirements } from '@/backend/agent/conversation-state';
import { auditDelivery } from '@/backend/services/delivery-audit';
import {
  assertPlanActionTask,
  planActionResponse,
} from '@/backend/api/plan-actions';
import {
  recommendMonitors,
  validateMonitorCriteria,
} from '@/backend/services/recommend-monitors';

export async function GET() {
  try {
    return json(await loadMonitorCatalog());
  } catch (cause) {
    return json(
      {
        error:
          cause instanceof Error ? cause.message : '显示器数据库暂时不可用',
      },
      503,
    );
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request);
    if (typeof input.taskId !== 'string' || !input.taskId)
      throw Error('当前主机任务无效');
    const session = sessionId(request);
    const workspace = readPageSession(session);
    assertPlanActionTask(input, workspace.task);
    if (!workspace.task.result?.plans.length)
      throw Error('请先完成主机配置，再选择显示器。');
    const requirements = completeRequirements(workspace.task.draft);
    const plans = auditDelivery(
      workspace.task.result.plans,
      requirements,
      await loadCatalog(),
    );
    const recommendation = recommendMonitors(
      validateMonitorCriteria(input.criteria ?? {}),
      await loadMonitorCatalog(),
    );
    const saved = updatePageTask(
      session,
      {
        ...workspace.task,
        result: {
          ...workspace.task.result,
          requirements,
          plans,
          monitorRecommendation: recommendation,
        },
      },
      workspace.task.version,
    );
    return json(planActionResponse(saved.task));
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : '显示器推荐失败' },
      400,
    );
  }
}
