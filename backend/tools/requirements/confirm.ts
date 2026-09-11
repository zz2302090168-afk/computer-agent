import type { Category } from '../../domain/types';
import { auditDelivery } from '../../services/delivery-audit';
import {
  applyDraft,
  completeRequirements,
} from '../../agent/conversation-state';
import {
  categories,
  categorySchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { assertCurrentTaskUserMessage } from './message';
export const confirmSelectionsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'confirm_selections',
      description:
        '仅记录用户对部分配件类别的确认，不代表整套方案确认。用户确认当前这套主机或全部配件时必须使用select_plan(confirm=true)。只能确认当前任务中已经存在的类别，并保存对应用户消息ID。',
      parameters: objectSchema(
        {
          categories: {
            type: 'array',
            items: categorySchema,
            minItems: 1,
            maxItems: 8,
          },
          sourceMessageId: { type: 'string' },
        },
        ['categories', 'sourceMessageId'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['categories', 'sourceMessageId']);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (!runtime.result?.plans.length)
      throw Error('请先生成并审核完整配置后再确认');
    context.catalog = await context.reloadCatalog();
    const audited = auditDelivery(
      runtime.result.plans,
      completeRequirements(runtime.draft),
      context.catalog,
    );
    if (audited.some((plan) => plan.deliveryAudit?.status !== 'passed'))
      throw Error('当前仅是超预算参考，请先明确提高预算后再确认');
    runtime.result = { ...runtime.result, plans: audited };
    if (
      !Array.isArray(input.categories) ||
      !input.categories.length ||
      !input.categories.every(
        (category) =>
          typeof category === 'string' &&
          categories.includes(category as Category),
      )
    )
      throw Error('确认配件类别无效');
    const selectionSources: Partial<Record<Category, 'confirmed'>> = {},
      selectionConfirmationMessageIds: Partial<Record<Category, string>> = {};
    for (const category of new Set(input.categories as Category[])) {
      if (!runtime.draft.partSelections?.[category])
        throw Error(`当前任务尚未选择 ${category}`);
      selectionSources[category] = 'confirmed';
      selectionConfirmationMessageIds[category] =
        input.sourceMessageId as string;
    }
    runtime.draft = applyDraft(runtime.draft, {
      selectionSources,
      selectionConfirmationMessageIds,
    });
    await context.onUpdate?.('requirements', runtime.draft, runtime.result);
    runtime.toolsUsed.push('记录用户确认');
    return {
      categories: Object.keys(selectionSources),
      sourceMessageId: input.sourceMessageId,
    };
  },
};
