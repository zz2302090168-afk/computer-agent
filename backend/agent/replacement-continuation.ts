import type { ReplacementFilter } from '../services/find-replacements';

export type ReplacementContinuation = {
  planId: string;
  items: ReplacementFilter[];
  offset: number;
  limit: number;
  sort?: 'price_asc' | 'price_desc';
  totalPriceRelation: 'cheaper' | 'any';
  searchScope: 'until_candidate';
};

type ReplacementOutput = {
  operation?: { tool?: string; failed?: boolean };
  data?: {
    planId?: string;
    query?: ReplacementFilter[];
    candidates?: unknown[];
    offset?: number;
    nextOffset?: number | null;
    totalPriceRelation?: 'cheaper' | 'any';
    searchScope?: string;
  };
} | null;

function queryKey(
  planId: string,
  items: ReplacementFilter[],
  totalPriceRelation: 'cheaper' | 'any' | undefined,
  sort: unknown,
) {
  return JSON.stringify({
    planId,
    items: items
      .map((item) => ({
        category: item.category,
        productId: item.productId ?? '',
        brand: item.brand ?? '',
        modelKeyword: item.modelKeyword ?? '',
        color: item.color ?? '不限',
        priceRelation: item.priceRelation ?? 'any',
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    totalPriceRelation: totalPriceRelation ?? 'any',
    sort: sort === 'price_desc' ? 'price_desc' : 'price_asc',
  });
}

export function updateReplacementContinuations(
  pending: ReplacementContinuation[],
  output: unknown,
  args: Record<string, unknown>,
) {
  const result = output as ReplacementOutput;
  const data = result?.data;
  if (
    result?.operation?.tool !== 'find_replacements' ||
    result.operation.failed !== false ||
    !data ||
    typeof data.planId !== 'string' ||
    !Array.isArray(data.query)
  )
    return;
  const key = queryKey(
    data.planId,
    data.query,
    data.totalPriceRelation,
    args.sort,
  );
  // 同批次的后续查询可能已找到候选，或明确要求只看本页。
  // 只撤销同一查询的旧续页，不影响另一个方案/条件的未完成查询。
  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index];
    if (
      queryKey(item.planId, item.items, item.totalPriceRelation, item.sort) ===
      key
    )
      pending.splice(index, 1);
  }
  const next = replacementContinuation(output, args);
  if (next) pending.push(next);
}

// 仅使用注册工具成功返回的完整查询条件；不从助手正文判断是否应继续。
export function replacementContinuation(
  output: unknown,
  args: Record<string, unknown>,
): ReplacementContinuation | undefined {
  const result = output as ReplacementOutput;
  const data = result?.data;
  if (
    result?.operation?.tool !== 'find_replacements' ||
    result.operation.failed !== false ||
    !data ||
    data.searchScope !== 'until_candidate' ||
    !Array.isArray(data.candidates) ||
    data.candidates.length !== 0 ||
    typeof data.planId !== 'string' ||
    !Array.isArray(data.query) ||
    !data.query.length ||
    typeof data.offset !== 'number' ||
    typeof data.nextOffset !== 'number' ||
    !Number.isSafeInteger(data.nextOffset) ||
    data.nextOffset <= data.offset
  )
    return undefined;
  return {
    planId: data.planId,
    items: structuredClone(data.query),
    offset: data.nextOffset,
    limit: typeof args.limit === 'number' ? args.limit : 10,
    ...(args.sort === 'price_desc' || args.sort === 'price_asc'
      ? { sort: args.sort }
      : {}),
    totalPriceRelation: data.totalPriceRelation ?? 'any',
    searchScope: 'until_candidate',
  };
}

export const replacementLimitReply =
  '本轮已达到查询轮数上限，尚未完成的替换查询仍有未检查的后续组合。尚未查完，不能据此判断整个目录没有符合条件的方案。';
