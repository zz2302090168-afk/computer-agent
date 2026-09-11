import type { Catalog, PcTask, RecommendationResult } from '../domain/types';
import { completeRequirements } from '../agent/conversation-state';
import { auditDelivery } from './delivery-audit';
import { resolvePlan } from './resolve-plan';

// 选择与确认共享服务，网页和模型工具均保存明确的方案归属。
export function selectPlan(
  task: PcTask,
  planId: string,
  catalog: Catalog,
  source: Pick<
    NonNullable<RecommendationResult['selection']>,
    'source' | 'messageId'
  >,
  confirm = false,
): PcTask {
  const selected = resolvePlan(task.result, planId);
  const requirements = completeRequirements(task.draft);
  const plan = auditDelivery([selected], requirements, catalog)[0]!;
  if (confirm && plan.deliveryAudit?.status !== 'passed')
    throw Error('当前仅是超预算参考，不能确认；请先明确提高预算');
  const draft = {
    ...task.draft,
    partSelections: Object.fromEntries(
      plan.parts.map((part) => [part.category, part.id]),
    ),
    selectionSources: Object.fromEntries(
      plan.parts.map((part) => [
        part.category,
        confirm
          ? ('confirmed' as const)
          : task.draft.partPreferences?.[part.category] === part.id
            ? ('user' as const)
            : ('assistant' as const),
      ]),
    ),
    selectionConfirmationMessageIds:
      confirm && source.messageId
        ? Object.fromEntries(
            plan.parts.map((part) => [part.category, source.messageId!]),
          )
        : {},
  };
  return {
    ...task,
    draft,
    issues: [],
    result: {
      ...task.result!,
      selection: {
        planId: plan.id,
        status: confirm ? 'confirmed' : 'selected',
        ...source,
      },
      requirements: completeRequirements(draft),
      plans: task.result!.plans.map((item) =>
        item.id === plan.id ? plan : item,
      ),
      evaluation: undefined,
      explanation: null,
      summary: `${confirm ? '已确认' : '已选定'}${plan.tier ?? plan.name}，未重新选型。${plan.budget.reason}；${plan.kind === 'prebuilt' ? '商家整机不执行DIY配件兼容性审核。' : '未知兼容项目仍需核实。'}`,
    },
  };
}
