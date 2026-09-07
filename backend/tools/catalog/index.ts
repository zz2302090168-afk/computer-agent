import type { Category, Part } from '../../domain/types';
import { searchCatalog } from '../../services/catalog-search';
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
        '按类别、品牌、型号关键词、颜色和目录价区间查询数据库商品。用户指定型号时先查询；多个版本时向用户澄清。',
      parameters: objectSchema({
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
    const matches = searchCatalog(context.catalog.parts, {
      category: category as Category | undefined,
      brand: text('brand'),
      modelKeyword: text('modelKeyword'),
      color: text('color'),
      minPrice: number('minPrice'),
      maxPrice: number('maxPrice'),
    }).slice(0, 20);
    if (matches.length === 1) runtime.approvedPartIds.add(matches[0]!.id);
    else if (matches.length > 1) runtime.ambiguousSearch = true;
    else runtime.emptySearch = true;
    runtime.toolsUsed.push('查询商品');
    return matches.map((part: Part) => ({
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
    }));
  },
};
