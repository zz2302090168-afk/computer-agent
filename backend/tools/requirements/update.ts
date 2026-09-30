import { assertCurrentTaskUserMessage } from './message';
import { clearComputedSelection } from './state';
import {
  applyDraft,
  changesRecommendation,
} from '../../agent/conversation-state';
import { objectSchema, parseObject, type RegisteredTool } from '../types';
import { requirementPatchProperties, validateRequirementPatch } from './schema';
export const updateRequirementsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_requirements',
      description:
        '把用户明确表达的预算、用途、购买方式、颜色、品牌、系列或具体商品更新到当前任务。5060 等芯片名称属于 seriesPreferences；只有用户说出品牌和完整版本时才把精确查询所得 ID 写入 partPreferences。',
      parameters: objectSchema({
        ...requirementPatchProperties,
        zeroBudgetConfirmationMessageId: {
          type: 'string',
          description:
            '仅用户在收到零误差风险提示后明确确认坚持时填写当前用户消息ID，不得引用最初提出零误差的消息。',
        },
        rebuild: {
          type: 'boolean',
          description:
            '仅用户明确要求整体重新配置时设true；已有方案的局部配件修改应调用replace_parts',
        },
      }),
    },
  },
  async execute(value, context, runtime) {
    const { rebuild, zeroBudgetConfirmationMessageId, ...values } =
      parseObject(value);
    if (rebuild !== undefined && typeof rebuild !== 'boolean')
      throw Error('rebuild必须为布尔值');
    const patch = validateRequirementPatch(values);
    if (runtime.candidateSubmissionKeys?.size && Object.keys(patch).length)
      throw Error('候选修复中不得改写用户需求；请在当前约束内修正或报告冲突');
    if (Array.isArray(patch.requirementItems)) {
      for (const item of patch.requirementItems) {
        const source = assertCurrentTaskUserMessage(
          context,
          item.sourceMessageId,
        );
        if (
          item.sourceMessageId !== context.currentMessageId ||
          !source.content.includes(item.text)
        )
          throw Error('需求条目必须逐字引用当前用户消息，不得从助手文案生成');
      }
    }
    if (
      runtime.result?.plans.length &&
      !rebuild &&
      [
        'partPreferences',
        'seriesPreferences',
        'excludedModels',
        'excludedBrands',
        'excludedColors',
        'brandPreferences',
        'partColors',
      ].some((key) => key in patch)
    )
      throw Error(
        '当前已有方案，配件级修改请直接调用replace_parts，保留其他配件；只有明确要求整套重配时才使用rebuild=true',
      );
    if (
      patch.partPreferences &&
      typeof patch.partPreferences === 'object' &&
      !Array.isArray(patch.partPreferences)
    )
      for (const [category, id] of Object.entries(patch.partPreferences)) {
        if (typeof id !== 'string' || !id) throw Error('指定型号商品 ID 无效');
        if (
          !runtime.approvedPartIds.has(id) ||
          !context.catalog.parts.some(
            (part) => part.id === id && part.category === category,
          )
        )
          throw Error('指定型号尚未通过当前轮次的精确目录查询');
      }
    const previous = runtime.draft,
      next = applyDraft(previous, patch);
    const source = context.messages.find(
      (message) =>
        message.id === context.currentMessageId && message.role === 'user',
    );
    if (source && Object.keys(patch).length)
      next.requirementOrigins = {
        ...previous.requirementOrigins,
        ...Object.fromEntries(
          Object.keys(patch).map((key) => [
            key,
            { text: source.content, sourceMessageId: context.currentMessageId },
          ]),
        ),
      };
    // 仅纠正结构化字段中与目录CPU品牌完全相同的值，不解析用户意图或放宽具体型号。
    const series = next.seriesPreferences?.cpu?.trim().toLowerCase();
    const cpuBrand =
      series &&
      context.catalog.parts.find(
        (part) =>
          part.category === 'cpu' &&
          [
            part.brand.toLowerCase(),
            ...part.brand.toLowerCase().split(/\s+/),
          ].includes(series),
      )?.brand;
    if (cpuBrand) {
      const requestedBrand = next.brandPreferences?.cpu?.trim().toLowerCase();
      if (
        requestedBrand &&
        ![
          cpuBrand.toLowerCase(),
          ...cpuBrand.toLowerCase().split(/\s+/),
        ].includes(requestedBrand)
      )
        throw Error(
          'CPU品牌与误填在型号字段中的品牌冲突，请核对用户需求后同时修正brandPreferences.cpu和seriesPreferences.cpu',
        );
      next.brandPreferences = { ...next.brandPreferences, cpu: cpuBrand };
      next.seriesPreferences = { ...next.seriesPreferences };
      delete next.seriesPreferences.cpu;
    }
    if (zeroBudgetConfirmationMessageId !== undefined) {
      assertCurrentTaskUserMessage(context, zeroBudgetConfirmationMessageId);
      if (
        zeroBudgetConfirmationMessageId !== context.currentMessageId ||
        !next.zeroBudgetPromptMessageId ||
        next.zeroBudgetPromptMessageId === context.currentMessageId ||
        next.budgetTolerance !== 0
      )
        throw Error('必须先提示零误差风险，等待后续用户消息明确确认');
      next.zeroBudgetConfirmed = true;
    }
    if (next.budgetTolerance === 0 && !next.zeroBudgetConfirmed) {
      next.zeroBudgetPromptMessageId ??= context.currentMessageId;
      runtime.requestAction = 'save_requirements';
    }
    const changed = changesRecommendation(previous, next);
    const nextDraft = changed ? clearComputedSelection(next) : next;
    if (
      changed ||
      next.zeroBudgetPromptMessageId !== previous.zeroBudgetPromptMessageId ||
      next.zeroBudgetConfirmed !== previous.zeroBudgetConfirmed
    ) {
      await context.onUpdate?.('requirements', nextDraft, null);
    }
    runtime.draft = nextDraft;
    if (changed) runtime.result = null;
    runtime.toolsUsed.push('记录需求');
    return {
      draft: runtime.draft,
      recommendationExpired: changed,
      ...(runtime.draft.budgetTolerance === 0 &&
      !runtime.draft.zeroBudgetConfirmed
        ? {
            budgetNotice:
              '当前误差为0，总价必须恰好等于预算，可能找不到匹配配置。请向用户说明并询问是否坚持零误差，等待用户确认后才能生成；未经用户同意不得放宽误差。',
          }
        : {}),
    };
  },
};
