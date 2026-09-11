import { labels, type Category } from '../../domain/types';
import { isColorCategory } from '../../rules/color';
import { resolvePlan } from '../../services/resolve-plan';
import {
  findReplacements,
  type ReplacementFilter,
} from '../../services/find-replacements';
import {
  categorySchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

const filterFields = {
  category: categorySchema,
  brand: { type: 'string' },
  modelKeyword: { type: 'string' },
  color: { type: 'string', enum: ['黑色', '白色', '不限'] },
};
function parseFilter(value: unknown): ReplacementFilter {
  const input = parseObject(value);
  rejectUnknownKeys(input, Object.keys(filterFields));
  if (
    typeof input.category !== 'string' ||
    !Object.hasOwn(labels, input.category)
  )
    throw Error('配件类别无效');
  for (const field of ['brand', 'modelKeyword', 'color'])
    if (input[field] !== undefined && typeof input[field] !== 'string')
      throw Error(`${field}必须为字符串`);
  if (
    input.color !== undefined &&
    !['黑色', '白色', '不限'].includes(input.color as string)
  )
    throw Error('颜色无效');
  if (
    input.color &&
    input.color !== '不限' &&
    !isColorCategory(input.category as string)
  )
    throw Error('CPU和硬盘不参与配色，替换这两类配件时不能设置颜色条件');
  return {
    category: input.category as Category,
    brand: input.brand as string | undefined,
    modelKeyword: input.modelKeyword as string | undefined,
    color: input.color as string | undefined,
  };
}
export const findReplacementsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'find_replacements',
      description:
        '只读查询单件或多件联动替换，固定未指定类别并整体审核预算和兼容性。单件用category及过滤条件；联动用items数组，二者不可混用。同方案同类别省略的过滤条件沿用最近一次查询；用户明确取消型号或品牌限制时传空字符串，取消颜色限制传不限。返回组合、拒绝原因和分页。省略planId时用已选或唯一方案，多套未选时返回选项。不会修改配置。',
      parameters: objectSchema({
        planId: { type: 'string' },
        ...filterFields,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: objectSchema(filterFields, ['category']),
        },
        sort: { type: 'string', enum: ['price_asc', 'price_desc'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'planId',
      ...Object.keys(filterFields),
      'items',
      'sort',
      'offset',
      'limit',
    ]);
    if (input.planId !== undefined && typeof input.planId !== 'string')
      throw Error('planId必须为字符串');
    if (
      input.sort !== undefined &&
      (typeof input.sort !== 'string' ||
        !['price_asc', 'price_desc'].includes(input.sort))
    )
      throw Error('排序无效');
    let items: ReplacementFilter[];
    if (input.items !== undefined) {
      if (Object.keys(filterFields).some((key) => input[key] !== undefined))
        throw Error('items不能与顶层类别或过滤条件混用');
      if (
        !Array.isArray(input.items) ||
        !input.items.length ||
        input.items.length > 8
      )
        throw Error('items必须包含1到8个不同类别');
      items = input.items.map(parseFilter);
    } else
      items = [
        parseFilter(
          Object.fromEntries(
            Object.keys(filterFields)
              .filter((key) => input[key] !== undefined)
              .map((key) => [key, input[key]]),
          ),
        ),
      ];
    if (new Set(items.map((item) => item.category)).size !== items.length)
      throw Error('替换类别不能重复');
    const offset = input.offset ?? 0,
      limit = input.limit ?? 10;
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw Error('分页参数无效');
    context.catalog = await context.reloadCatalog();
    const plan = resolvePlan(
      runtime.result,
      input.planId as string | undefined,
    );
    // 查询约束随聊天保存；新增联动类别不应清掉原类别的筛选条件。
    const previous = context.messages
      .filter(
        (message) =>
          message.taskId === context.taskId && message.role === 'assistant',
      )
      .flatMap((message) => message.replacementQueries ?? [])
      .filter((entry) => entry.role === 'tool')
      .map(
        (entry) =>
          JSON.parse(entry.content ?? '{}') as {
            data?: { planId?: string; query?: ReplacementFilter[] };
          },
      )
      .findLast((entry) => entry.data?.planId === plan.id && entry.data.query)
      ?.data?.query;
    items = items.map((item) => {
      const prior = previous?.find(
        (filter) => filter.category === item.category,
      );
      return {
        ...item,
        brand: item.brand ?? prior?.brand,
        modelKeyword: item.modelKeyword ?? prior?.modelKeyword,
        color: item.color ?? prior?.color,
      };
    });
    return findReplacements(
      { ...runtime.task, draft: runtime.draft, result: runtime.result },
      {
        planId: input.planId as string | undefined,
        items,
        sort: input.sort as 'price_asc' | 'price_desc' | undefined,
        offset,
        limit,
      },
      context.catalog,
    );
  },
};
