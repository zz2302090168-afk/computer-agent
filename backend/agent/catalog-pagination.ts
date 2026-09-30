import { activeExecutionNode } from './execution-plan';
import type { ToolRuntime } from '../tools/types';

export function catalogPaginationHint(runtime: ToolRuntime) {
  const node = activeExecutionNode(runtime);
  if (node?.catalogScope !== 'all') return '';
  return `全量目录查询：${JSON.stringify(node.catalogProgress ?? { nextOffset: 0 })}。每页上限=${node.catalogPageSize ?? '沿用首查询'}。必须保持筛选条件和limit，按nextOffset连续翻页；complete不为true时禁止声称查完。`;
}

function queryKey(args: Record<string, unknown>) {
  return JSON.stringify(
    Object.entries({
      ...args,
      kind: args.kind ?? 'part',
      sort: args.sort ?? 'price_asc',
      limit: args.limit ?? 10,
    })
      .filter(([k]) => k !== 'offset')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function assertCatalogPageRequest(
  runtime: ToolRuntime,
  args: Record<string, unknown>,
) {
  const node = activeExecutionNode(runtime);
  if (!node) return;
  const limit = args.limit ?? 10;
  if (
    node.catalogPageSize !== undefined &&
    (typeof limit !== 'number' || limit > node.catalogPageSize)
  )
    throw Error(`本项每页最多${node.catalogPageSize}条，不可增大limit`);
  if (node.catalogScope !== 'all') return;
  const progress = node.catalogProgress;
  if ((args.offset ?? 0) !== (progress?.nextOffset ?? 0) || progress?.complete)
    throw Error('全量查询必须从offset=0开始，并按返回nextOffset连续翻页');
  const planned =
    node.invocation?.tool === 'search_catalog'
      ? queryKey(node.invocation.arguments)
      : undefined;
  if (
    (progress?.key ?? planned) !== undefined &&
    queryKey(args) !== (progress?.key ?? planned)
  )
    throw Error('全量查询必须保持原筛选条件和limit，不得收窄范围或跳过商品');
}

// 只记录当前节点实际成功返回的分页证据，不从模型文字推断完成。
export function recordCatalogPage(
  runtime: ToolRuntime,
  args: Record<string, unknown>,
  output: unknown,
) {
  const node = activeExecutionNode(runtime);
  if (node?.catalogScope !== 'all' || !output || typeof output !== 'object')
    return;
  if (
    !('operation' in output) ||
    !output.operation ||
    typeof output.operation !== 'object' ||
    !('failed' in output.operation) ||
    output.operation.failed !== false
  )
    return;
  if (!('data' in output) || !output.data || typeof output.data !== 'object')
    return;
  const data = output.data;
  if (
    !('offset' in data) ||
    !('nextOffset' in data) ||
    !('matchCount' in data) ||
    typeof data.matchCount !== 'number' ||
    !('matches' in data) ||
    !Array.isArray(data.matches)
  )
    return;
  const key = queryKey(args);
  const previous = node.catalogProgress;
  const offset = data.offset;
  if (
    offset !== (previous?.nextOffset ?? 0) ||
    (previous &&
      (previous.key !== key ||
        previous.total !== data.matchCount ||
        previous.complete))
  )
    return;
  const ids: string[] = [];
  for (const match of data.matches) {
    if (!match || typeof match !== 'object' || typeof match.id !== 'string')
      return;
    ids.push(match.id);
  }
  const allIds = [...(previous?.ids ?? []), ...ids];
  const next = data.nextOffset;
  if (
    new Set(allIds).size !== allIds.length ||
    (next !== null &&
      (typeof next !== 'number' ||
        next !== Number(offset) + ids.length ||
        ids.length === 0))
  )
    return;
  node.catalogProgress = {
    key,
    nextOffset: next,
    total: data.matchCount,
    ids: allIds,
    complete: next === null && allIds.length === data.matchCount,
  };
}
