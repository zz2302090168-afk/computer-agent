import {
  labels,
  type Catalog,
  type Plan,
  type Requirements,
} from '../domain/types';
import { matchesRequirementColor, requiredPartColor } from '../rules/color';
import { assembleBuild, selectPrebuilt } from './recommend';
import { ToolExecutionError } from '../domain/errors';

// 交付审核只接受商品ID，以当前需求和数据库重新验证，忽略候选自带的合格标签。
// DIY 复用完整硬规则；商家整机只核对商品、八类构成、价格、预算、配色和用户约束。
export function auditDelivery(
  plans: Plan[],
  requirements: Requirements,
  catalog: Catalog,
): Plan[] {
  const issues: { planId: string; productIds: string[]; reason: string }[] = [];
  const audited = plans.map((plan) => {
    const ids = Array.isArray(plan.parts)
      ? plan.parts.map((part) => part.id)
      : [];
    try {
      const items = ids.map((id) =>
        catalog.parts.find((part) => part.id === id),
      );
      if (
        ids.length !== Object.keys(labels).length ||
        new Set(ids).size !== ids.length ||
        items.some((part) => !part) ||
        new Set(items.map((part) => part?.category)).size !==
          Object.keys(labels).length
      )
        throw Error('必须包含数据库中八类完整且不重复的商品');
      const colorIssues = items.flatMap((part) =>
        part && !matchesRequirementColor(part, requirements, catalog.parts)
          ? [
              labels[part.category] +
                '实际为' +
                part.color +
                '，不符合' +
                requiredPartColor(part, requirements) +
                '要求',
            ]
          : [],
      );
      if (colorIssues.length) throw Error(colorIssues.join('；'));
      const fresh =
        plan.kind === 'diy'
          ? assembleBuild(ids, requirements, catalog.parts, catalog.prebuilts)
          : selectPrebuilt(
              plan.id,
              requirements,
              catalog.parts,
              catalog.prebuilts,
            );
      if (fresh.total !== plan.total)
        throw Error('数据库报价已变化，请重新报价后交付');
      if (
        fresh.parts.length !== ids.length ||
        fresh.parts.some((part) => !ids.includes(part.id))
      )
        throw Error('数据库整机配件构成已变化，请重新选择');
      return {
        ...fresh,
        id: plan.id,
        tier: plan.tier,
        deliveryAudit: {
          status: fresh.budget.confirmable
            ? ('passed' as const)
            : ('reference' as const),
          checkedAt: new Date().toISOString(),
        },
      };
    } catch (cause) {
      issues.push({
        planId: plan.id,
        productIds: ids,
        reason: cause instanceof Error ? cause.message : '配置审核失败',
      });
      return plan;
    }
  });
  if (issues.length)
    throw new ToolExecutionError(
      '交付审核未通过：' + issues.map((issue) => issue.reason).join('；'),
      {
        code: 'delivery_audit_failed',
        issues,
        retryable: true,
        guidance:
          '根据当前用户要求查询替代候选并重新组装；不得放宽要求、声称已满足或直接确认',
      },
    );
  return audited;
}
