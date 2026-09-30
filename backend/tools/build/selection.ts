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
  const nextDraft = applyDraft(
    runtime.draft,
    recordPlanSelections(plan, requirements),
  );
  // 配件事实先写入本次对话的临时状态；后续方案事件中断时仍可在当前页面继续。
  await context.onUpdate?.('parts', nextDraft, null);
  runtime.draft = nextDraft;
  runtime.result = null;
  const result: NonNullable<ToolRuntime['result']> = {
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
  const version = await context.onUpdate?.('plan', runtime.draft, result);
  runtime.result = result;
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
      requirementChecks: plan.requirementAcceptance?.checks,
    },
    version,
  };
}
