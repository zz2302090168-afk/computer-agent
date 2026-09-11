import {
  completeRequirements,
  applyDraft,
} from '../../agent/conversation-state';
import type { Plan, Requirements } from '../../domain/types';
import { type ToolContext, type ToolRuntime } from '../types';
import { auditDelivery } from '../../services/delivery-audit';

export function recordPlanSelections(plan: Plan, requirements: Requirements) {
  const partSelections = Object.fromEntries(
    plan.parts.map((part) => [part.category, part.id]),
  );
  const selectionSources = Object.fromEntries(
    plan.parts.map((part) => [
      part.category,
      requirements.selectionSources?.[part.category] ??
        (requirements.partPreferences?.[part.category] ? 'user' : 'assistant'),
    ]),
  );
  return { partSelections, selectionSources };
}

export async function saveSelectedPlan(
  plan: Plan,
  requirements: Requirements,
  context: ToolContext,
  runtime: ToolRuntime,
) {
  plan = auditDelivery(
    [plan],
    completeRequirements(runtime.draft),
    context.catalog,
  )[0]!;
  runtime.draft = applyDraft(
    runtime.draft,
    recordPlanSelections(plan, requirements),
  );
  // 配件事实先独立持久化；即使之后方案事件中断，已成功选中的数据库商品仍可恢复。
  await context.onUpdate?.('parts', runtime.draft, null);
  runtime.result = {
    requirements: {
      ...requirements,
      partSelections: runtime.draft.partSelections,
      selectionSources: runtime.draft.selectionSources,
    },
    plans: [plan],
    evidence: [],
    summary: `${plan.budget.label} · ${plan.budget.reason}`,
    budgetDiagnostic: {
      status: plan.budget.status,
      minimumReference: plan.budget.minimumReference,
      highReference: plan.budget.highReference,
      reason: plan.budget.reason,
      searchComplete: true,
    },
    modelStatus: '模型对话与工具调用',
  };
  const version = await context.onUpdate?.(
    'plan',
    runtime.draft,
    runtime.result,
  );
  runtime.toolsUsed.push(
    '自主选型',
    '读取数据库',
    ...(plan.kind === 'diy' ? ['检查兼容性'] : []),
    '校验预算',
  );
  return {
    plan: {
      id: plan.id,
      total: plan.total,
      parts: plan.parts.map((part) => ({
        id: part.id,
        category: part.category,
        brand: part.brand,
        name: part.name,
        color: part.color,
      })),
      validation: plan.validation,
      budget: plan.budget,
      deliveryAudit: plan.deliveryAudit,
    },
    version,
  };
}
