import { labels } from '../../domain/types';
import { completeRequirements } from '../../agent/conversation-state';
import { auditDelivery } from '../../services/delivery-audit';
import { purposeBudgetWeights } from '../../services/selection-policy';
import { retrieveKnowledge } from '../../rag/retrieve';
import { resolvePlan } from '../../services/resolve-plan';
import {
  categorySchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const explainSelectionTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'explain_selection',
      description:
        '只读提供当前方案或某件配件的选择依据：真实规格、用途约束、业务预算分配权重及知识库。省略planId时使用已选定或唯一方案。用于为什么选这款，不修改需求、方案或历史。',
      parameters: objectSchema(
        { planId: { type: 'string' }, category: categorySchema },
        [],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['planId', 'category']);
    if (
      (input.planId !== undefined && typeof input.planId !== 'string') ||
      (input.category !== undefined &&
        (typeof input.category !== 'string' ||
          !Object.hasOwn(labels, input.category)))
    )
      throw Error('方案或配件类别无效');
    const selected = resolvePlan(
      runtime.result,
      input.planId as string | undefined,
    );
    const requirements = completeRequirements(runtime.draft);
    context.catalog = await context.reloadCatalog();
    const plan = auditDelivery([selected], requirements, context.catalog)[0]!;
    const weights =
      purposeBudgetWeights[requirements.purpose] ?? purposeBudgetWeights.游戏;
    return {
      planId: plan.id,
      requirements,
      budget: plan.budget,
      validation: plan.validation,
      policyMeaning:
        '权重是程序候选排序的用途预算分配偏好，不是模型内部权重、实测性能分数或硬性配额。它说明选型方向，不证明某型号最优或当时选择的唯一原因；整机使用套餐价。',
      parts: await Promise.all(
        plan.parts
          .filter((part) => !input.category || part.category === input.category)
          .map(async (part) => ({
            id: part.id,
            category: part.category,
            brand: part.brand,
            name: part.name,
            specs: part.specs,
            color: part.color,
            catalogPrice: part.price,
            userSpecified:
              requirements.partPreferences?.[part.category] === part.id,
            seriesRequirement: requirements.seriesPreferences?.[part.category],
            budgetWeight: weights[Object.keys(labels).indexOf(part.category)],
            evidence: await retrieveKnowledge(
              context.embeddingConfig ?? {},
              `${requirements.purpose} ${labels[part.category]} ${part.name} 为什么这样选 为什么先检查 主要取舍 预算 兼容`,
              4,
              'sales',
              undefined,
              context.signal,
            ),
          })),
      ),
      guidance:
        '围绕这款分清三类依据：满足哪些当前用途与约束；为什么优先核对相关兼容项；在预算、容量、扩展、尺寸、供电或散热上的主要取舍。只引用返回的真实规格和知识，不编造性能，不讨论未查询的替代型号。知识库通用建议只能解释检查逻辑，不能补成该型号的厂家规格或实测证据。',
    };
  },
};
