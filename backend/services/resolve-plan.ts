import type { RecommendationResult } from '../domain/types';
import { ToolExecutionError } from '../domain/errors';

export function resolvePlan(
  result: RecommendationResult | null,
  planId?: string,
) {
  if (!result?.plans.length) throw Error('当前没有完整配置，请先生成方案');
  const id = planId ?? result.selection?.planId;
  if (id !== undefined) {
    const plan = result.plans.find((item) => item.id === id);
    if (!plan) throw Error('指定方案不属于当前配置或已经失效');
    return plan;
  }
  if (result.plans.length === 1) return result.plans[0]!;
  throw new ToolExecutionError(
    '当前有多套配置，请先明确哪一套，不默认选择第一套',
    {
      code: 'plan_choice_required',
      choices: result.plans.map((plan) => ({
        planId: plan.id,
        name: plan.tier ?? plan.name,
        total: plan.total,
      })),
    },
  );
}
