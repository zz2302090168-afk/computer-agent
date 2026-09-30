import type { ToolRuntime } from '../tools/types';
import { activeExecutionNode, expectedResultPending } from './execution-plan';

// 仅优化已完整规划的纯目录查询；复杂任务、分页及任何失败继续原模型循环。
export function canCompleteDirectQuery(runtime: ToolRuntime, output: unknown) {
  const plan = runtime.executionPlan,
    node = activeExecutionNode(runtime);
  if (
    !plan ||
    plan.nodes.length < 2 ||
    !node?.directAttempted ||
    !node.invocation ||
    !node.expected ||
    runtime.consultPrebuiltId ||
    !plan.nodes.every(
      (entry) =>
        entry.action === 'search_catalog' &&
        !!entry.invocation &&
        !!entry.expected,
    ) ||
    expectedResultPending(runtime)
  )
    return false;
  if (
    !output ||
    typeof output !== 'object' ||
    !('operation' in output) ||
    !output.operation ||
    typeof output.operation !== 'object' ||
    !('failed' in output.operation) ||
    output.operation.failed !== false ||
    !('data' in output)
  )
    return false;
  const data = output.data;
  return (
    !!data &&
    typeof data === 'object' &&
    'nextOffset' in data &&
    data.nextOffset === null
  );
}
