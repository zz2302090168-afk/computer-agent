import type { Category } from '../../domain/types';
import { auditDelivery } from '../../services/delivery-audit';
import { resolvePlan } from '../../services/resolve-plan';
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
        '仅确认已选定或唯一方案中的部分配件类别，不代表整套方案确认。多套未选定时先明确方案并调用select_plan。用户确认当前这套主机或全部配件时必须使用select_plan(confirm=true)。保存当前用户消息ID。',
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
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('确认配件必须依据当前用户消息');
    if (
      !Array.isArray(input.categories) ||
      !input.categories.length ||
      input.categories.length > categories.length ||
      !input.categories.every(
        (category) =>
          typeof category === 'string' &&
          categories.includes(category as Category),
      )
    )
      throw Error('确认配件类别无效');
    const selectedCategories = [...new Set(input.categories as Category[])];
    if (selectedCategories.length === categories.length)
      throw Error('确认整套主机或全部配件请使用select_plan(confirm=true)');
    const selected = resolvePlan(runtime.result);
    context.catalog = await context.reloadCatalog();
    const plan = auditDelivery(
      [selected],
      completeRequirements(runtime.draft),
      context.catalog,
    )[0]!;
    if (plan.deliveryAudit?.status !== 'passed')
      throw Error('当前仅是超预算参考，请先明确提高预算后再确认');
    const selectionSources: Partial<Record<Category, 'confirmed'>> = {},
      selectionConfirmationMessageIds: Partial<Record<Category, string>> = {},
      partSelections: Partial<Record<Category, string>> = {};
    for (const category of selectedCategories) {
      const part = plan.parts.find((item) => item.category === category)!;
      partSelections[category] = part.id;
      selectionSources[category] = 'confirmed';
      selectionConfirmationMessageIds[category] =
        input.sourceMessageId as string;
    }
    const draft = applyDraft(runtime.draft, {
      partSelections,
      selectionSources,
      selectionConfirmationMessageIds,
    });
    const result = {
      ...runtime.result!,
      requirements: completeRequirements(draft),
      plans: runtime.result!.plans.map((item) =>
        item.id === plan.id ? plan : item,
      ),
    };
    const version = await context.onUpdate?.('requirements', draft, result);
    runtime.draft = draft;
    runtime.result = result;
    runtime.task = {
      ...runtime.task,
      draft,
      result,
      version: version ?? runtime.task.version,
    };
    runtime.toolsUsed.push('记录用户确认');
    return {
      planId: plan.id,
      categories: Object.keys(selectionSources),
      partSelections,
      sourceMessageId: input.sourceMessageId,
      version,
    };
  },
};
