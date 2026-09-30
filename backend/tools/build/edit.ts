import { editPlanAsync } from '../../services/edit-plan';
import { applyDraft } from '../../agent/conversation-state';
import { requirementPatchProperties } from '../requirements/schema';
import { resolvePlan } from '../../services/resolve-plan';
import { assertCurrentTaskUserMessage } from '../requirements';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import type { Category } from '../../domain/types';

export const replacePartsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'replace_parts',
      description:
        '局部修改已有DIY方案，严格保留未指定替换的配件。省略planId时使用已选定或唯一方案，多套未选定则返回选项。先查询新商品，不要先update_requirements清空方案或重新配整套。失败保留原方案。',
      parameters: objectSchema(
        {
          planId: { type: 'string' },
          sourceMessageId: { type: 'string' },
          requirementItems: requirementPatchProperties.requirementItems,
          replacements: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: objectSchema(
              { oldId: { type: 'string' }, newId: { type: 'string' } },
              ['oldId', 'newId'],
            ),
          },
          partColors: objectSchema(
            Object.fromEntries(
              ['gpu', 'memory', 'motherboard', 'psu', 'case', 'cooler'].map(
                (category) => [
                  category,
                  {
                    type: 'string',
                    enum: ['白色', '黑色', '不限', '黑色优先，白色备选'],
                  },
                ],
              ),
            ),
            [],
          ),
        },
        ['sourceMessageId', 'replacements'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'planId',
      'sourceMessageId',
      'replacements',
      'partColors',
      'requirementItems',
    ]);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('局部替换必须依据当前用户消息');
    if (
      (input.planId !== undefined && typeof input.planId !== 'string') ||
      !Array.isArray(input.replacements)
    )
      throw Error('替换参数无效');
    const plan = resolvePlan(
      runtime.result,
      input.planId as string | undefined,
    );
    const replacements = input.replacements.map((item) => {
      const entry = parseObject(item);
      rejectUnknownKeys(entry, ['oldId', 'newId']);
      if (typeof entry.oldId !== 'string' || typeof entry.newId !== 'string')
        throw Error('商品ID无效');
      return { oldId: entry.oldId, newId: entry.newId };
    });
    const colors =
      input.partColors === undefined ? {} : parseObject(input.partColors);
    if (Object.values(colors).some((color) => typeof color !== 'string'))
      throw Error('配件颜色无效');
    context.catalog = await context.reloadCatalog();
    let draft = runtime.draft;
    if (input.requirementItems !== undefined) {
      draft = applyDraft(draft, { requirementItems: input.requirementItems });
      const source = assertCurrentTaskUserMessage(
        context,
        input.sourceMessageId,
      );
      for (const item of Array.isArray(input.requirementItems)
        ? input.requirementItems
        : []) {
        if (
          item.sourceMessageId !== context.currentMessageId ||
          !source.content.includes(item.text)
        )
          throw Error('需求必须引用当前用户原文');
      }
    }
    const existing = runtime.localEditRequest;
    const requirementPatch = JSON.stringify(input.requirementItems ?? []);
    const colorPatch = JSON.stringify(colors);
    if (
      existing?.messageId === context.currentMessageId &&
      existing.planId === plan.id
    ) {
      if (
        input.requirementItems !== undefined &&
        existing.requirementPatch !== requirementPatch
      )
        throw Error('修复期间不能修改或删除已经生效的需求；保留原约束继续修正');
      if (colorPatch !== existing.colorPatch)
        throw Error('修复期间不能放宽或修改已生效的配色约束');
      if (
        replacements.some(
          (entry) =>
            !existing.categories.includes(
              plan.parts.find((part) => part.id === entry.oldId)?.category ??
                '',
            ),
        )
      )
        throw Error('修复期间不能扩大替换范围，其余部件必须保持不变');
      draft = existing.draft;
    } else if (
      replacements.every((entry) =>
        plan.parts.some((part) => part.id === entry.oldId),
      )
    ) {
      runtime.localEditRequest = {
        messageId: context.currentMessageId,
        planId: plan.id,
        draft: structuredClone(draft),
        requirementPatch,
        colorPatch,
        categories: replacements.map(
          (entry) =>
            plan.parts.find((part) => part.id === entry.oldId)?.category ?? '',
        ),
      };
    }
    const edited = await editPlanAsync(
      [
        { ...runtime.task, draft, result: runtime.result },
        plan.id,
        replacements,
        context.catalog,
        colors as Partial<Record<Category, string>>,
      ],
      { signal: context.signal },
    );
    const version = await context.onUpdate?.(
      'plan',
      edited.draft,
      edited.result,
    );
    runtime.draft = edited.draft;
    runtime.result = edited.result;
    runtime.task = { ...edited, version: version ?? edited.version };
    return {
      plan: edited.result.plans[0],
      summary: edited.result.summary,
      version,
    };
  },
};
