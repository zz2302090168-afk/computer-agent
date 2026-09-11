import type { Category, Part } from '../../domain/types';
import { isColorCategory } from '../../rules/color';
import { searchCatalog, matchesModel } from '../../services/catalog-search';
import {
  categorySchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const searchCatalogTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'search_catalog',
      description:
        '查询数据库配件或整机，可按价格排序和翻页。颜色是本次查询的条件，不自动回退颜色。没有候选时，根据用户已授权的备选要求发起下一次查询。整机结果包含配件构成，需核对整套颜色。',
      parameters: objectSchema({
        kind: { type: 'string', enum: ['part', 'prebuilt'] },
        sort: { type: 'string', enum: ['price_desc', 'price_asc'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        category: categorySchema,
        brand: { type: 'string' },
        modelKeyword: { type: 'string' },
        color: { type: 'string' },
        minPrice: { type: 'number', minimum: 0 },
        maxPrice: { type: 'number', minimum: 0 },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value),
      allowed = [
        'kind',
        'sort',
        'offset',
        'limit',
        'category',
        'brand',
        'modelKeyword',
        'color',
        'minPrice',
        'maxPrice',
      ] as const;
    rejectUnknownKeys(input, allowed);
    const text = (key: string) =>
      input[key] === undefined
        ? undefined
        : typeof input[key] === 'string'
          ? (input[key] as string)
          : (() => {
              throw Error(`${key} 必须是字符串`);
            })();
    const number = (key: string) =>
      input[key] === undefined
        ? undefined
        : typeof input[key] === 'number' && Number.isFinite(input[key])
          ? (input[key] as number)
          : (() => {
              throw Error(`${key} 必须是有效数字`);
            })();
    const category = text('category');
    const kind = text('kind') ?? 'part';
    const sort = text('sort') ?? 'price_asc';
    const offset = number('offset') ?? 0;
    const limit = number('limit') ?? 10;
    if (
      !['part', 'prebuilt'].includes(kind) ||
      !['price_desc', 'price_asc'].includes(sort) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw Error('查询类型、排序或分页参数无效');
    if (kind === 'prebuilt' && category)
      throw Error('整机查询不能指定配件类别');
    if (
      category &&
      ![
        'cpu',
        'gpu',
        'memory',
        'motherboard',
        'psu',
        'case',
        'storage',
        'cooler',
      ].includes(category)
    )
      throw Error('商品类别无效');
    // 每次查询都重读数据库，避免模型基于过期目录继续组装。
    context.catalog = await context.reloadCatalog();
    const filter = {
      category: category as Category | undefined,
      brand: text('brand'),
      modelKeyword: text('modelKeyword'),
      color: text('color'),
      minPrice: number('minPrice'),
      maxPrice: number('maxPrice'),
    };
    if (
      kind === 'part' &&
      category &&
      filter.color &&
      filter.color !== '不限' &&
      !isColorCategory(category)
    )
      throw Error('CPU和硬盘不参与配色，查询这两类商品时不能设置颜色条件');
    const compare = (
      a: { price: number; id: string },
      b: { price: number; id: string },
    ) =>
      (sort === 'price_desc' ? b.price - a.price : a.price - b.price) ||
      a.id.localeCompare(b.id);
    if (
      (filter.minPrice !== undefined && filter.minPrice < 0) ||
      (filter.maxPrice !== undefined &&
        filter.maxPrice < (filter.minPrice ?? 0))
    )
      throw Error('价格区间无效');
    if (kind === 'prebuilt') {
      const all = context.catalog.prebuilts
        .filter(
          (pc) =>
            (!filter.brand ||
              pc.brand.toLowerCase().includes(filter.brand.toLowerCase())) &&
            (!filter.modelKeyword ||
              matchesModel(pc.name, filter.modelKeyword)) &&
            (!filter.color ||
              filter.color === '不限' ||
              pc.color.includes(filter.color)) &&
            pc.price >= (filter.minPrice ?? 0) &&
            pc.price <= (filter.maxPrice ?? Infinity),
        )
        .sort(compare);
      const matches = all.slice(offset, offset + limit);
      runtime.toolsUsed.push('查询整机候选');
      return {
        matchCount: all.length,
        sort,
        offset,
        nextOffset:
          offset + matches.length < all.length ? offset + matches.length : null,
        matches: matches.map((pc) => ({
          ...pc,
          parts: pc.partIds.map(
            (id) =>
              context.catalog.parts.find((part) => part.id === id) ?? {
                id,
                missing: true,
              },
          ),
        })),
      };
    }
    const all = searchCatalog(context.catalog.parts, filter).sort(compare);
    const matches = all.slice(offset, offset + limit);
    if (all.length === 1) runtime.approvedPartIds.add(all[0]!.id);
    runtime.toolsUsed.push('查询商品');
    return {
      filters: filter,
      categoryTotal: context.catalog.parts.filter(
        (part) => !filter.category || part.category === filter.category,
      ).length,
      evidenceScope:
        'matchCount仅代表本次过滤条件；categoryTotal才是该类别全目录数量。空查询不能证明整个类别没有商品。',
      matchCount: all.length,
      sort,
      offset,
      nextOffset:
        offset + matches.length < all.length ? offset + matches.length : null,
      requiresChoice: all.length > 1,
      matches: matches.map((part: Part) => ({
        id: part.id,
        category: part.category,
        brand: part.brand,
        fullModel: part.name,
        color: part.color,
        catalogPrice: part.price,
        keySpecs: Object.fromEntries(
          Object.entries(part.specs).filter(
            ([key]) => !['source', 'checkedAt', 'priceBasis'].includes(key),
          ),
        ),
        source: part.specs.source,
      })),
    };
  },
};
