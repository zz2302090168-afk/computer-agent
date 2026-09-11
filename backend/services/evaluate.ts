import type {
  Part,
  PlanEvaluation,
  RecommendationResult,
} from '../domain/types';
import { replacePart } from './recommend';
import { budgetRange } from '../rules/budget';
import { retrieveKnowledge } from '../rag/retrieve';
import { resolvePlan } from './resolve-plan';

export async function evaluatePlan(
  result: RecommendationResult,
  catalog: Part[],
  options: { planId?: string; candidateProductId?: string; focus?: string },
  embeddingConfig: import('../rag/retrieve').EmbeddingConfig,
  signal?: AbortSignal,
): Promise<PlanEvaluation> {
  const plan = resolvePlan(result, options.planId);
  if (!plan.budget)
    throw Error('当前方案缺少最新预算分类，请按当前数据库重新生成后再评估');
  const issues = [...plan.validation.issues],
    directions: string[] = [],
    suggestions: PlanEvaluation['suggestions'] = [];
  if (issues.length)
    directions.push(
      `先核实 ${issues.length} 项兼容性资料，未知项不能视为已经通过`,
    );
  const range = budgetRange(
      result.requirements.budget,
      result.requirements.hardCap,
      {
        minimum: plan.budget.minimumReference,
        high: plan.budget.highReference,
      },
      result.requirements.budgetTolerance,
    ),
    headroom = range.max - plan.total;
  if (headroom > 0)
    directions.push(
      `当前距离允许上界还有 ¥${headroom}，调整仍须重新校验预算和兼容性`,
    );
  if (options.candidateProductId) {
    const candidate = catalog.find(
      (part) => part.id === options.candidateProductId,
    );
    if (!candidate) throw Error('比较商品不存在');
    const old = plan.parts.find((part) => part.category === candidate.category);
    if (!old) throw Error('当前方案缺少对应类别');
    let valid = true,
      reason = '替换后满足当前预算、用户约束和已知兼容性规则';
    try {
      const updated = replacePart(
        plan,
        old.id,
        candidate.id,
        result.requirements,
        catalog,
      );
      reason =
        updated.budget.status === 'below_minimum_reference'
          ? '替换后仍是不可确认的超预算参考，需先提高预算'
          : '替换后满足当前预算、用户约束和已知兼容性规则';
    } catch (cause) {
      valid = false;
      reason = cause instanceof Error ? cause.message : '该替换不可用';
    }
    suggestions.push({
      id: `replace:${plan.id}:${old.id}:${candidate.id}`,
      planId: plan.id,
      category: candidate.category,
      oldProductId: old.id,
      candidateProductId: candidate.id,
      summary: `将 ${old.name} 与 ${candidate.name} 进行比较，目录价差 ¥${candidate.price - old.price}`,
      valid,
      reason,
    });
    directions.push(
      valid
        ? '该候选可以作为明确替换建议，执行前仍由服务端重新读取商品'
        : '该候选与当前约束存在冲突，只作为比较结果，不可直接执行',
    );
  }
  if (!options.candidateProductId) {
    const candidates = plan.parts
      .flatMap((old) =>
        result.requirements.partPreferences?.[old.category]
          ? []
          : catalog
              .filter(
                (candidate) =>
                  candidate.category === old.category &&
                  candidate.id !== old.id &&
                  candidate.price < old.price,
              )
              .map((candidate) => ({
                old,
                candidate,
                saving: old.price - candidate.price,
              })),
      )
      .sort((a, b) => a.saving - b.saving);
    for (const { old, candidate, saving } of candidates) {
      try {
        replacePart(plan, old.id, candidate.id, result.requirements, catalog);
        suggestions.push({
          id: `replace:${plan.id}:${old.id}:${candidate.id}`,
          planId: plan.id,
          category: candidate.category,
          oldProductId: old.id,
          candidateProductId: candidate.id,
          summary: `可将 ${old.name} 换为 ${candidate.name}，商家目录总价减少 ¥${saving}`,
          valid: true,
          reason:
            plan.budget.status === 'below_minimum_reference'
              ? '仍是不可确认的超预算参考，需先提高预算'
              : '替换后满足当前预算、用户约束和已知兼容性规则',
        });
        directions.push('找到一项可降低商家目录总价且不改变用户明确约束的调整');
        break;
      } catch {
        // 候选不满足预算、用户约束或兼容性时继续检查下一项，不把失败候选写成建议。
      }
    }
  }
  if (!directions.length)
    directions.push(
      '当前已录入规则未发现明确问题；如需调整，请先给出具体目标或候选配件',
    );
  return {
    planId: plan.id,
    issues,
    directions,
    suggestions,
    evidence: await retrieveKnowledge(
      embeddingConfig,
      `${options.focus ?? ''} ${result.requirements.purpose} 兼容 预算`,
      4,
      'sales',
      undefined,
      signal,
    ),
    createdAt: Date.now(),
  };
}
