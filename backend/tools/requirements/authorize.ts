import { clearComputedSelection } from './state';
import type { Category } from '../../domain/types';
import { applyDraft } from '../../agent/conversation-state';
import {
  categories,
  categorySchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { assertCurrentTaskUserMessage } from './message';
export const authorizeSelectionTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'authorize_selection',
      description:
        '记录用户允许助手在某一配件类别和明确范围内自主选择。sourceMessageId 必须指向当前任务中的真实用户消息。',
      parameters: objectSchema(
        {
          category: categorySchema,
          scopeType: {
            type: 'string',
            enum: ['series', 'current_constraints'],
          },
          scope: { type: 'string' },
          sourceMessageId: { type: 'string' },
        },
        ['category', 'scopeType', 'scope', 'sourceMessageId'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'category',
      'scopeType',
      'scope',
      'sourceMessageId',
    ]);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (runtime.result?.plans.some((plan) => !plan.budget))
      throw Error('当前方案的预算状态已过期，请重新生成后再确认');
    if (
      typeof input.category !== 'string' ||
      !categories.includes(input.category as Category)
    )
      throw Error('授权类别无效');
    if (!['series', 'current_constraints'].includes(String(input.scopeType)))
      throw Error('授权范围类型无效');
    if (typeof input.scope !== 'string' || !input.scope.trim())
      throw Error('授权范围不能为空');
    const category = input.category as Category,
      scope = input.scope.trim().slice(0, 100),
      patch: Record<string, unknown> = {
        selectionAuthorizations: { [category]: scope },
        selectionAuthorizationMessageIds: { [category]: input.sourceMessageId },
      };
    if (input.scopeType === 'series')
      patch.seriesPreferences = { [category]: scope };
    const nextDraft = clearComputedSelection(applyDraft(runtime.draft, patch));
    await context.onUpdate?.('requirements', nextDraft, null);
    runtime.draft = nextDraft;
    runtime.result = null;
    runtime.toolsUsed.push('记录选择授权');
    return { category, scope, sourceMessageId: input.sourceMessageId };
  },
};
