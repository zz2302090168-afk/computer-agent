import { readJson, sessionId, json } from '@/backend/api/http';
import { completeRequirements } from '@/backend/agent/conversation-state';
import { loadCatalog } from '@/backend/db/catalog';
import { readPageSession } from '@/backend/session/page-session';
import { auditDelivery } from '@/backend/services/delivery-audit';
import { buildPlanDocx } from '@/backend/services/export-docx';
import { resolvePlan } from '@/backend/services/resolve-plan';
import { assertPlanActionTask } from '@/backend/api/plan-actions';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const input = await readJson(request);
    if (typeof input.planId !== 'string' || !input.planId.trim())
      throw Error('导出方案参数无效');
    const { task } = readPageSession(sessionId(request));
    assertPlanActionTask(input, task);
    const requirements = completeRequirements(task.draft);
    const selected = resolvePlan(task.result, input.planId);
    const plan = auditDelivery(
      [selected],
      requirements,
      await loadCatalog(),
    )[0]!;
    const buffer = await buildPlanDocx(plan, requirements);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition':
          "attachment; filename=PC-build-plan.docx; filename*=UTF-8''%E7%94%B5%E8%84%91%E9%85%8D%E7%BD%AE%E6%96%B9%E6%A1%88.docx",
      },
    });
  } catch (cause) {
    return json(
      { error: cause instanceof Error ? cause.message : 'Word 文件生成失败' },
      400,
    );
  }
}
