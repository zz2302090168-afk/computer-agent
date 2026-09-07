import {
  completeRequirements,
  applyDraft,
} from '../../agent/conversation-state';
import { budgetRange } from '../../rules/budget';
import {
  assembleBuild,
  recommend,
  replacePart,
} from '../../services/recommend';
import { retrieveKnowledge } from '../../rag/retrieve';
import type { Plan, Requirements } from '../../domain/types';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export function executePartReplacement(
  value: unknown,
  plan: Plan,
  requirements: Requirements,
  catalog: import('../../domain/types').Part[],
) {
  const input = parseObject(value);
  rejectUnknownKeys(input, ['planId', 'oldId', 'newId']);
  if (typeof input.oldId !== 'string' || typeof input.newId !== 'string')
    throw Error('替换商品 ID 无效');
  return replacePart(plan, input.oldId, input.newId, requirements, catalog);
}

function recordPlanSelections(plan: Plan, requirements: Requirements) {
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

export const recommendPcTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'recommend_pc',
      description: '按已记录需求生成数据库基础方案。需求变化后必须重新调用。',
      parameters: objectSchema({}),
    },
  },
  async execute(value, context, runtime) {
    rejectUnknownKeys(parseObject(value), []);
    runtime.attemptedPlanTool = true;
    context.catalog = await context.reloadCatalog();
    let requirements = completeRequirements(runtime.draft);
    const plans = recommend(
      requirements,
      context.catalog.parts,
      context.catalog.prebuilts,
    );
    if (plans[0]) {
      runtime.draft = applyDraft(
        runtime.draft,
        recordPlanSelections(plans[0], requirements),
      );
      requirements = completeRequirements(runtime.draft);
      await context.onUpdate?.('parts', runtime.draft, null);
    }
    const range = budgetRange(requirements.budget, requirements.hardCap),
      evidence = retrieveKnowledge(
        `${requirements.purpose} ${requirements.game} 预算 兼容`,
        5,
      );
    runtime.result = {
      requirements,
      plans,
      evidence,
      summary: plans.length
        ? `匹配 ${plans.length} 套候选 · 允许总价 ¥${range.min}～¥${range.max}`
        : '当前条件下无匹配方案。',
      modelStatus: '模型对话与工具调用',
    };
    const version = await context.onUpdate?.(
      'plan',
      runtime.draft,
      runtime.result,
    );
    if (plans.length) runtime.successfulPlanTool = 'recommend';
    runtime.toolsUsed.push('选配商品', '检查兼容性', '校验预算');
    return {
      plans: plans.map((plan) => ({
        id: plan.id,
        total: plan.total,
        parts: plan.parts.map((part) => ({
          id: part.id,
          name: part.name,
          brand: part.brand,
        })),
        validation: plan.validation,
      })),
      summary: runtime.result.summary,
      version,
    };
  },
};

export const assembleBuildTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'assemble_build',
      description:
        '提交自主挑选的八类商品 ID。服务端重读数据库、重新计价并校验完整性、需求、预算和兼容性。整机模式不可调用。',
      parameters: objectSchema(
        {
          productIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 8,
            maxItems: 8,
          },
        },
        ['productIds'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['productIds']);
    if (
      !Array.isArray(input.productIds) ||
      input.productIds.length !== 8 ||
      !input.productIds.every((id) => typeof id === 'string' && id)
    )
      throw Error('productIds 必须包含八个商品 ID');
    runtime.attemptedPlanTool = true;
    const requirements = completeRequirements(runtime.draft);
    // 模型只提交 ID；价格、规格与总价都从最新数据库记录重新计算。
    context.catalog = await context.reloadCatalog();
    const plan = assembleBuild(
        input.productIds,
        requirements,
        context.catalog.parts,
      ),
      range = budgetRange(requirements.budget, requirements.hardCap),
      evidence = retrieveKnowledge(
        `${requirements.purpose} ${requirements.game} 预算 兼容`,
        5,
      );
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
      evidence,
      summary: `自主选型已通过服务端校验 · 允许总价 ¥${range.min}～¥${range.max}`,
      modelStatus: '模型对话与工具调用',
    };
    const version = await context.onUpdate?.(
      'plan',
      runtime.draft,
      runtime.result,
    );
    runtime.successfulPlanTool = 'assemble';
    runtime.toolsUsed.push('自主选型', '读取数据库', '检查兼容性', '校验预算');
    return {
      plan: {
        id: plan.id,
        total: plan.total,
        parts: plan.parts.map((part) => ({
          id: part.id,
          category: part.category,
          brand: part.brand,
          name: part.name,
        })),
        validation: plan.validation,
      },
      version,
    };
  },
};
