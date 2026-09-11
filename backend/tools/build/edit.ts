import { editPlan } from '../../services/edit-plan';
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
    const edited = editPlan(
      { ...runtime.task, draft: runtime.draft, result: runtime.result },
      plan.id,
      replacements,
      context.catalog,
      colors as Partial<Record<Category, string>>,
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
