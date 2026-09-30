import {
  labels,
  type Catalog,
  type Plan,
  type Requirements,
} from '../domain/types';

import {
  assembleBuild,
  selectPrebuilt,
  prepareRequirementAcceptance,
} from './recommend';
import type { RequirementJudgeOptions } from '../agent/jev-requirements';
import { ToolExecutionError } from '../domain/errors';

// 交付审核只接受商品ID，以当前需求和数据库重新验证，忽略候选自带的合格标签。
// DIY 复用完整硬规则；商家整机只核对商品、八类构成、价格、预算、配色和用户约束。
export function auditDelivery(
  plans: Plan[],
  requirements: Requirements,
  catalog: Catalog,
  purpose: 'delivery' | 'analysis' = 'delivery',
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
      const fresh =
        plan.kind === 'diy'
          ? assembleBuild(
              ids,
              requirements,
              catalog.parts,
              catalog.prebuilts,
              plan.requirementAcceptance,
            )
          : selectPrebuilt(
              plan.id,
              requirements,
              catalog.parts,
              catalog.prebuilts,
              plan.requirementAcceptance,
            );
      if (fresh.total !== plan.total)
        throw Error('数据库报价已变化，请重新报价后交付');
      if (
        fresh.parts.length !== ids.length ||
        fresh.parts.some((part) => !ids.includes(part.id))
      )
        throw Error('数据库整机配件构成已变化，请重新选择');
      if (
        purpose === 'delivery' &&
        fresh.kind === 'diy' &&
        fresh.validation.status !== 'pass'
      )
        throw new ToolExecutionError(
          '适配性无法确认，不能最终交付：' + fresh.validation.issues.join('；'),
          {
            code: 'compatibility_unconfirmed',
            stage: 'compatibility',
            candidateVersion: fresh.requirementAcceptance?.candidateVersion,
            productIds: ids,
            status: fresh.validation.status,
            issues: fresh.validation.issues,
            preserveConstraints: requirements,
            retryable: true,
            guidance:
              '优先补查可信商品资料，不得把资料不足当成零件不合格。保留全部硬约束与未获授权的部件；修改后重新需求验收。',
          },
        );
      return {
        ...fresh,
        id: plan.id,
        tier: plan.tier,
        deliveryAudit:
          purpose === 'analysis'
            ? undefined
            : {
                status: fresh.budget.confirmable
                  ? ('passed' as const)
                  : ('reference' as const),
                checkedAt: new Date().toISOString(),
              },
      };
    } catch (cause) {
      if (cause instanceof ToolExecutionError) throw cause;
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

export async function auditDeliveryAsync(
  plans: Plan[],
  requirements: Requirements,
  catalog: Catalog,
  options: RequirementJudgeOptions = {},
) {
  const accepted: Plan[] = [];
  for (const plan of plans) {
    const receipt = await prepareRequirementAcceptance(
      plan.parts.map((part) => part.id),
      requirements,
      catalog.parts,
      catalog.prebuilts,
      plan.kind === 'prebuilt' ? plan.id : undefined,
      options,
      plan.requirementAcceptance,
    );
    accepted.push({ ...plan, requirementAcceptance: receipt });
  }
  return auditDelivery(accepted, requirements, catalog);
}
