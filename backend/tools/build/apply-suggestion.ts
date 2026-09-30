import {
  completeRequirements,
  applyDraft,
} from '../../agent/conversation-state';
import {
  replacePart,
  prepareRequirementAcceptance,
} from '../../services/recommend';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { assertCurrentTaskUserMessage } from '../requirements';
import { auditDelivery } from '../../services/delivery-audit';
import type { RecommendationResult } from '../../domain/types';

export const applySuggestionTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'apply_suggestion',
      description:
        '执行当前方案评估中一条已验证的明确建议。必须提供建议 ID 和用户接受该建议的消息 ID；执行时重新读取数据库并校验全部约束。',
      parameters: objectSchema(
        {
          suggestionId: { type: 'string' },
          sourceMessageId: { type: 'string' },
        },
        ['suggestionId', 'sourceMessageId'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['suggestionId', 'sourceMessageId']);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('执行建议必须引用当前这条用户消息');
    if (typeof input.suggestionId !== 'string' || !input.suggestionId)
      throw Error('建议 ID 无效');
    const suggestion = runtime.result?.evaluation?.suggestions.find(
      (item) => item.id === input.suggestionId,
    );
    if (!suggestion) throw Error('当前任务中没有这条建议');
    if (!suggestion.valid) throw Error(suggestion.reason || '该建议不可执行');
    context.catalog = await context.reloadCatalog();
    const plan = runtime.result!.plans.find(
      (item) => item.id === suggestion.planId,
    );
    if (!plan) throw Error('建议对应方案已失效');
    const requirements = completeRequirements(runtime.draft);
    const acceptance = await prepareRequirementAcceptance(
      plan.parts.map((part) =>
        part.id === suggestion.oldProductId
          ? suggestion.candidateProductId
          : part.id,
      ),
      requirements,
      context.catalog.parts,
      context.catalog.prebuilts,
      undefined,
      { signal: context.signal },
    );
    const candidate = replacePart(
        plan,
        suggestion.oldProductId,
        suggestion.candidateProductId,
        requirements,
        context.catalog.parts,
        context.catalog.prebuilts,
        acceptance,
      ),
      updated = auditDelivery([candidate], requirements, context.catalog)[0]!,
      category = suggestion.category;
    if (!updated.budget.confirmable)
      throw Error(
        '替换后仍是超预算参考，不能记录为已确认；请先明确提高主机预算',
      );
    const nextDraft = applyDraft(runtime.draft, {
      partSelections: { [category]: suggestion.candidateProductId },
      selectionSources: { [category]: 'confirmed' },
      selectionConfirmationMessageIds: { [category]: input.sourceMessageId },
    });
    const nextResult: RecommendationResult = {
      ...runtime.result!,
      selection: undefined,
      requirements: {
        ...requirements,
        partSelections: nextDraft.partSelections,
        selectionSources: nextDraft.selectionSources,
        selectionConfirmationMessageIds:
          nextDraft.selectionConfirmationMessageIds,
      },
      plans: runtime.result!.plans.map((item) =>
        item.id === plan.id ? updated : item,
      ),
      evaluation: undefined,
      summary: '已执行用户确认的评估建议，并重新完成预算和兼容性检查。',
      budgetDiagnostic: {
        status: updated.budget.status,
        minimumReference: updated.budget.minimumReference,
        highReference: updated.budget.highReference,
        reason: updated.budget.reason,
        searchComplete: true,
      },
    };
    await context.onUpdate?.('plan', nextDraft, nextResult);
    runtime.draft = nextDraft;
    runtime.result = nextResult;
    runtime.toolsUsed.push(
      '执行评估建议',
      '读取数据库',
      '检查兼容性',
      '校验预算',
    );
    return {
      planId: updated.id,
      total: updated.total,
      validation: updated.validation,
      budget: updated.budget,
      sourceMessageId: input.sourceMessageId,
    };
  },
};
