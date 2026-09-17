import type { Category, Part } from '../../domain/types';
import {
  catalogPageReply,
  catalogPrebuiltPageReply,
} from '../../agent/catalog-reply';
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
        '只读查询数据库配件或整机，可按价格排序和翻页，无需预算用途。整机咨询可用kind=prebuilt及精确prebuiltId读取该台当前售价与配件构成；查询不代表已符合用户需求、已选定或已确认兼容。颜色是本次查询的条件，不自动回退颜色。没有候选时，根据用户已授权的备选要求发起下一次查询。整机结果包含配件构成，需核对整套颜色。',
      parameters: objectSchema({
        kind: { type: 'string', enum: ['part', 'prebuilt'] },
        prebuiltId: { type: 'string' },
        sort: { type: 'string', enum: ['price_desc', 'price_asc'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        category: categorySchema,
        brand: { type: 'string' },
        modelKeyword: { type: 'string' },
        color: { type: 'string' },
        minPrice: {
          type: ['number', 'null'],
          minimum: 0,
          description: '单件最低价；未指定时传null或省略。',
        },
        maxPrice: {
          type: ['number', 'null'],
          minimum: 0,
          description:
            '单件最高价；未指定时传null或省略。0仅表示用户要查零元商品，不表示不限。',
        },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value),
      allowed = [
        'kind',
        'prebuiltId',
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
    const price = (key: string) => {
      const value = input[key];
      if (value === null) return undefined;
      // 部分模型将JSON价格序列化为字符串；只接受无歧义的十进制数，不解析自然语言。
      if (
        typeof value === 'string' &&
        /^\d+(?:\.\d+)?$/.test(value) &&
        Number.isFinite(Number(value))
      )
        return Number(value);
      return number(key);
    };
    const category = text('category');
    const kind = text('kind') ?? 'part';
    const prebuiltId = text('prebuiltId');
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
    if (prebuiltId !== undefined && (kind !== 'prebuilt' || !prebuiltId.trim()))
      throw Error('prebuiltId 仅可用于整机查询，且必须为有效整机 ID');
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
    if (runtime.consultPrebuiltId && !runtime.consultPrebuiltQueried) {
      if (kind !== 'prebuilt' || prebuiltId !== runtime.consultPrebuiltId)
        throw Error(
          `请先精确查询本次咨询的组装整机：kind=prebuilt，prebuiltId=${runtime.consultPrebuiltId}`,
        );
      runtime.consultPrebuiltQueried = true;
    }
    // 每次查询都重读数据库，避免模型基于过期目录继续组装。
    context.catalog = await context.reloadCatalog();
    if (
      prebuiltId !== undefined &&
      !context.catalog.prebuilts.some((pc) => pc.id === prebuiltId)
    )
      throw Error('查询的组装整机已不在当前商品目录，请重新选择');
    const filter = {
      category: category as Category | undefined,
      brand: text('brand'),
      modelKeyword: text('modelKeyword'),
      color: text('color'),
      minPrice: price('minPrice'),
      maxPrice: price('maxPrice'),
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
    const evidenceReply = (reply: string) => {
      if (runtime.requestAction !== 'search_catalog') return {};
      runtime.catalogReplies ??= new Map();
      runtime.catalogReplies.set(
        JSON.stringify({ kind, prebuiltId, filter, sort, offset, limit }),
        reply,
      );
      return {
        displayReply: [...runtime.catalogReplies.values()].join('\n\n'),
      };
    };
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
            (!prebuiltId || pc.id === prebuiltId) &&
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
        ...evidenceReply(
          catalogPrebuiltPageReply(
            matches,
            context.catalog.parts,
            offset + matches.length < all.length
              ? offset + matches.length
              : null,
          ),
        ),
        evidenceScope:
          '仅为当前目录商品资料，未审核是否符合当前任务需求或预算，未选定或确认；商家整机不执行DIY配件兼容性审核。咨询回复介绍整机名称、售价和八类商品名称，不输出内部ID或字段英文。目录未记录售价是否包含组装费、其他费用、保修或运费，包含情况未知；不能断言包含，也不能断言不包含、免费或必须另付。用户问及这些项目时明确说明目录未提供，需另行核实；用户没有问费用组成时只报目录售价。整套配色分别按显卡、内存、主板、电源、机箱和散热的实际颜色说明，不把机箱颜色扩展成整套配色；未查得规格不能凭型号补充。',
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
      ...evidenceReply(
        catalogPageReply(
          matches,
          offset + matches.length < all.length ? offset + matches.length : null,
        ),
      ),
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
        demo: part.demo,
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
