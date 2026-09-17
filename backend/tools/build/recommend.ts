import {
  completeRequirements,
  applyDraft,
} from '../../agent/conversation-state';
import { recommendDetailed } from '../../services/recommend';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { auditDelivery } from '../../services/delivery-audit';
import { exploreParallelPlans } from '../../agent/parallel-plans';
import { searchCatalogTool } from '../catalog';
import { recordPlanSelections } from './selection';
import { assembleBuildTool } from './assemble';
import { selectPrebuiltTool } from './select-prebuilt';
import { recommendationReply } from '../../agent/sales-reply';
export const recommendPcTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'recommend_pc',
      description:
        '正常推荐调用本工具，并发探索贴近预算的三套不同方案后统一审核保存。明确只要最贵或最便宜时搜索单套；预算低于目录最低或高于最高时仅交付对应参考。',
      parameters: objectSchema({}),
    },
  },
  async execute(value, context, runtime) {
    rejectUnknownKeys(parseObject(value), []);
    context.catalog = await context.reloadCatalog();
    context.onProgress?.({
      scope: 'main',
      label: '核实目录边界与预算内候选',
      status: 'running',
    });
    let requirements = completeRequirements(runtime.draft);
    const { plans: candidates, failure } = recommendDetailed(
      requirements,
      context.catalog.parts,
      context.catalog.prebuilts,
    );
    const normal =
      !requirements.preferExpensive &&
      !requirements.preferCheaper &&
      candidates[0]?.budget.status === 'standard';
    const explored = normal
      ? await exploreParallelPlans(candidates, context, runtime, [
          searchCatalogTool,
          assembleBuildTool,
          selectPrebuiltTool,
        ])
      : candidates;
    context.signal?.throwIfAborted();
    context.onProgress?.({
      scope: 'main',
      label: '按最新需求与商品统一审核全部方案',
      status: 'running',
    });
    context.catalog = await context.reloadCatalog();
    const plans = auditDelivery(explored, requirements, context.catalog);
    if (plans[0]) {
      const nextDraft = applyDraft(
        runtime.draft,
        recordPlanSelections(plans[0], requirements),
      );
      await context.onUpdate?.('parts', nextDraft, null);
      runtime.draft = nextDraft;
      runtime.result = null;
      requirements = completeRequirements(runtime.draft);
    }
    const primaryBudget = plans[0]?.budget;
    const result: NonNullable<typeof runtime.result> = {
      requirements,
      plans,
      evidence: [],
      summary: plans.length
        ? primaryBudget!.status === 'below_minimum_reference'
          ? `预算低于最低完整配置 ¥${primaryBudget!.minimumReference}；展示 ${plans.length} 套超预算参考，不能直接确认购买`
          : primaryBudget!.status === 'above_high_reference'
            ? `预算高于目录最高完整兼容参考 ¥${primaryBudget!.highReference}；展示 ${plans.length} 套目录最高参考并允许节省`
            : `匹配 ${plans.length} 套贴近预算的候选 · ${primaryBudget!.reason}${normal && plans.length < 3 ? '；本轮仅找到这些不重复的可用方案，未凑齐三套' : ''}`
        : failure!.reason,
      budgetDiagnostic: primaryBudget
        ? {
            status: primaryBudget.status,
            minimumReference: primaryBudget.minimumReference,
            highReference: primaryBudget.highReference,
            reason: primaryBudget.reason,
            searchComplete: true,
          }
        : {
            status: 'standard',
            reason: failure!.reason,
            searchComplete: failure!.searchComplete,
            kind: failure!.kind,
          },
      modelStatus: '模型对话与工具调用',
    };
    const version = await context.onUpdate?.('plan', runtime.draft, result);
    runtime.result = result;
    runtime.toolsUsed.push(
      '选配商品',
      ...(plans.some((plan) => plan.kind === 'diy') ? ['检查兼容性'] : []),
      '校验预算',
    );
    return {
      displayReply: recommendationReply(result),
      plans: plans.map((plan) => ({
        id: plan.id,
        tier: plan.tier,
        total: plan.total,
        parts: plan.parts.map((part) => ({
          id: part.id,
          name: part.name,
          color: part.color,
          brand: part.brand,
        })),
        validation: plan.validation,
        budget: plan.budget,
        deliveryAudit: plan.deliveryAudit,
      })),
      summary: runtime.result.summary,
      budgetDiagnostic: runtime.result.budgetDiagnostic,
      version,
    };
  },
};
