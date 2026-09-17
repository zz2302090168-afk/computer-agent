import { labels, type Category } from '../../domain/types';
import { replacementPreviewReply } from '../../agent/sales-reply';
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
  productId: {
    type: 'string',
    description:
      '当前目录中的精确商品ID。用户指定具体商品时先search_catalog核实商品身份，再用返回ID绑定；不能凭名称拼造ID。其他明确品牌、型号、颜色和价格条件仍需同时满足。传空字符串可取消精确绑定；新品牌或型号查询未提供ID时不继承旧ID。',
  },
  brand: { type: 'string' },
  modelKeyword: { type: 'string' },
  color: { type: 'string', enum: ['黑色', '白色', '不限'] },
  priceRelation: {
    type: 'string',
    enum: ['cheaper', 'any'],
    description:
      '该类别配件相对原件的价格关系。只有用户明确要求该单件或每一件都更便宜时，才填cheaper，严格排除同价和更贵。多件联动仅要求合计或整套降价时，各items的本字段省略或填any，只设totalPriceRelation=cheaper，不额外收紧为每件降价。取消单件限制填any；排序不能代替价格过滤。',
  },
};
function parseFilter(value: unknown): ReplacementFilter {
  const input = parseObject(value);
  rejectUnknownKeys(input, Object.keys(filterFields));
  if (
    typeof input.category !== 'string' ||
    !Object.hasOwn(labels, input.category)
  )
    throw Error('配件类别无效');
  for (const field of ['productId', 'brand', 'modelKeyword', 'color'])
    if (input[field] !== undefined && typeof input[field] !== 'string')
      throw Error(`${field}必须为字符串`);
  if (
    typeof input.productId === 'string' &&
    input.productId !== '' &&
    !input.productId.trim()
  )
    throw Error('商品ID不能只包含空白字符');
  if (
    input.color !== undefined &&
    !['黑色', '白色', '不限'].includes(input.color as string)
  )
    throw Error('颜色无效');
  if (
    input.priceRelation !== undefined &&
    !['cheaper', 'any'].includes(input.priceRelation as string)
  )
    throw Error('配件价格关系无效');
  if (
    input.color &&
    input.color !== '不限' &&
    !isColorCategory(input.category as string)
  )
    throw Error('CPU和硬盘不参与配色，替换这两类配件时不能设置颜色条件');
  return {
    category: input.category as Category,
    productId: input.productId as string | undefined,
    brand: input.brand as string | undefined,
    modelKeyword: input.modelKeyword as string | undefined,
    color: input.color as string | undefined,
    priceRelation: input.priceRelation as ReplacementFilter['priceRelation'],
  };
}
export const findReplacementsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'find_replacements',
      description:
        '只读查询单件或多件联动替换，固定未指定类别并整体审核预算和兼容性。单件用category及过滤条件；联动用items数组，二者不可混用。指定具体商品时先search_catalog核实身份，再用productId查询替换；精确ID不覆盖用户明确的其他筛选条件。同方案同类别省略的过滤条件沿用最近一次查询；新品牌或型号查询不继承旧productId。用户明确取消商品ID、型号或品牌限制时传空字符串，取消颜色限制传不限。返回组合、拒绝原因和分页。省略planId时用已选或唯一方案，多套未选时返回选项。不会修改配置。',
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
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            '原始组合的起始位置。searchScope=page时必须明确提供，第一页为0；按用户指定页确定，不得自行跳页。',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            '本页最多检查的原始组合数量。searchScope=page时必须明确提供；用户只看前1个组合则为1，不能用默认10替代用户指定数量。',
        },
        searchScope: {
          type: 'string',
          enum: ['until_candidate', 'page'],
          description:
            '默认until_candidate：本页没有审核合格候选且还有下一页时，在当前轮数上限内继续相同条件查询；找到候选即停。用户明确只看指定页、只查一页或要求不继续时必须用page，保留该页结果，不自动翻页。',
        },
        totalPriceRelation: {
          type: 'string',
          enum: ['cheaper', 'any'],
          description:
            '整组替换后主机总价的关系。用户仅要求整体更便宜时用cheaper，允许个别配件涨价但组合总价须严格降低；每件都更便宜另在各items中声明priceRelation=cheaper。取消整体价格关系时any；同方案且同类别集合省略时沿用。',
        },
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
      'totalPriceRelation',
      'searchScope',
    ]);
    if (
      input.searchScope !== undefined &&
      !['until_candidate', 'page'].includes(input.searchScope as string)
    )
      throw Error('查询范围无效');
    if (
      input.searchScope === 'page' &&
      (input.offset === undefined || input.limit === undefined)
    )
      throw Error(
        '只查询指定页时必须明确提供offset和limit，按用户指定的起始位置与组合数量填写；不得沿用默认10个组合。',
      );
    if (input.planId !== undefined && typeof input.planId !== 'string')
      throw Error('planId必须为字符串');
    if (
      input.totalPriceRelation !== undefined &&
      !['cheaper', 'any'].includes(input.totalPriceRelation as string)
    )
      throw Error('整体价格关系无效');
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
            data?: {
              planId?: string;
              query?: ReplacementFilter[];
              totalPriceRelation?: 'cheaper' | 'any';
            };
          },
      )
      .findLast(
        (entry) => entry.data?.planId === plan.id && entry.data.query,
      )?.data;
    items = items.map((item) => {
      const prior = previous?.query?.find(
        (filter) => filter.category === item.category,
      );
      return {
        ...item,
        productId:
          item.productId ??
          (item.brand === undefined && item.modelKeyword === undefined
            ? prior?.productId
            : undefined),
        brand: item.brand ?? prior?.brand,
        modelKeyword: item.modelKeyword ?? prior?.modelKeyword,
        color: item.color ?? prior?.color,
        priceRelation: item.priceRelation ?? prior?.priceRelation,
      };
    });
    const sameCategories =
      previous?.query
        ?.map((item) => item.category)
        .sort()
        .join('|') ===
      items
        .map((item) => item.category)
        .sort()
        .join('|');
    const totalPriceRelation =
      (input.totalPriceRelation as 'cheaper' | 'any' | undefined) ??
      (sameCategories ? previous?.totalPriceRelation : undefined);
    const result = findReplacements(
      { ...runtime.task, draft: runtime.draft, result: runtime.result },
      {
        planId: input.planId as string | undefined,
        items,
        sort: input.sort as 'price_asc' | 'price_desc' | undefined,
        offset,
        limit,
        totalPriceRelation,
      },
      context.catalog,
    );
    return {
      ...result,
      searchScope: input.searchScope ?? 'until_candidate',
      displayReply: replacementPreviewReply(result),
    };
  },
};
