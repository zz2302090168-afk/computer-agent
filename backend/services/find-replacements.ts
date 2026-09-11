import type { Catalog, Category, PcTask } from '../domain/types';
import { searchCatalog } from './catalog-search';
import { editPlan } from './edit-plan';
import { resolvePlan } from './resolve-plan';

export type ReplacementFilter = {
  category: Category;
  brand?: string;
  modelKeyword?: string;
  color?: string;
};
export type ReplacementQuery = {
  planId?: string;
  items: ReplacementFilter[];
  sort?: 'price_asc' | 'price_desc';
  offset?: number;
  limit?: number;
};

// 单件与多件都通过同一次整体编辑审核；查询不写任务。
export function findReplacements(
  task: PcTask,
  query: ReplacementQuery,
  catalog: Catalog,
) {
  const plan = resolvePlan(task.result, query.planId);
  if (plan.kind !== 'diy')
    throw Error('商家整机不能拆换配件；若要DIY需用户明确同意');
  const groups = query.items.map((filter) => {
    const old = plan.parts.find((part) => part.category === filter.category);
    if (!old) throw Error('当前配置缺少待替换类别，请重新审核');
    const parts = searchCatalog(catalog.parts, filter)
      .filter(
        (part) =>
          part.id !== old.id &&
          (!filter.color ||
            filter.color === '不限' ||
            part.color === filter.color),
      )
      .sort(
        (a, b) =>
          (query.sort === 'price_desc'
            ? b.price - a.price
            : a.price - b.price) || a.id.localeCompare(b.id),
      );
    return { filter, old, parts };
  });
  const matchCount = groups.reduce(
    (count, group) => count * group.parts.length,
    1,
  );
  if (!Number.isSafeInteger(matchCount))
    throw Error('候选组合过多，请按型号或品牌缩小查询范围');
  const offset = query.offset ?? 0,
    limit = query.limit ?? 10;
  const proposedPartColors = Object.fromEntries(
    query.items
      .filter((item) => item.color)
      .map((item) => [item.category, item.color!]),
  ) as Partial<Record<Category, string>>;
  const candidates = [],
    rejected = [];
  // 直接按页索引展开笛卡尔积，不将全目录组合装入内存。
  for (
    let index = offset;
    index < Math.min(matchCount, offset + limit);
    index++
  ) {
    let cursor = index;
    const parts = groups.map((group) => group.old);
    for (let i = groups.length - 1; i >= 0; i--) {
      parts[i] = groups[i].parts[cursor % groups[i].parts.length];
      cursor = Math.floor(cursor / groups[i].parts.length);
    }
    const replacements = parts.map((part, i) => ({
      oldId: groups[i].old.id,
      newId: part.id,
    }));
    try {
      const edited = editPlan(
        task,
        plan.id,
        replacements,
        catalog,
        proposedPartColors,
      );
      const updated = edited.result.plans[0]!;
      if (updated.deliveryAudit?.status !== 'passed')
        throw Error('该候选仅能形成超预算参考，不能作为预算合格替换');
      candidates.push({
        ...(parts.length === 1
          ? {
              productId: parts[0].id,
              name: parts[0].name,
              color: parts[0].color,
              price: parts[0].price,
            }
          : {}),
        replacements,
        parts: parts.map(({ id, category, name, color, price }) => ({
          id,
          category,
          name,
          color,
          price,
        })),
        total: updated.total,
        difference: updated.total - plan.total,
        validation: updated.validation,
      });
    } catch (cause) {
      rejected.push({
        ...(parts.length === 1 ? { productId: parts[0].id } : {}),
        replacements,
        reason: cause instanceof Error ? cause.message : '替换未通过审核',
      });
    }
  }
  return {
    planId: plan.id,
    query: query.items,
    ...(groups.length === 1
      ? {
          oldProductId: groups[0].old.id,
          category: groups[0].filter.category,
          categoryTotal: catalog.parts.filter(
            (part) => part.category === groups[0].filter.category,
          ).length,
        }
      : {}),
    categories: groups.map(({ filter, old, parts }) => ({
      category: filter.category,
      oldProductId: old.id,
      matchCount: parts.length,
      categoryTotal: catalog.parts.filter(
        (part) => part.category === filter.category,
      ).length,
    })),
    matchCount,
    offset,
    nextOffset: offset + limit < matchCount ? offset + limit : null,
    candidates,
    rejected,
    proposedPartColors,
    preservedProductIds: plan.parts
      .filter(
        (part) => !query.items.some((item) => item.category === part.category),
      )
      .map((part) => part.id),
    guidance:
      '仅为整体审核后的替换预览，未修改任务。组合按items类别顺序及各类价格排序，不代表全局总价排序。无结果仅限当前过滤和分页。向用户列出选项时注明配件名称和商品ID，以便后续轮次准确引用；实际替换须用replace_parts一次提交组合并重新审核。颜色覆盖需用户同意后提交。',
  };
}
