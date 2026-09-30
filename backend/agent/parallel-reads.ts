import type { ToolDefinition } from './chat-model';
import type { ToolContext, ToolRuntime } from '../tools/types';
import { directTaskInvocation, executeRegisteredTool } from '../tools/registry';
import { toolMetadata } from '../tools/metadata';

export const MAX_PARALLEL_READS = 4;
export type PreparedRead = {
  plan: NonNullable<ToolRuntime['executionPlan']>;
  invocation: { tool: string; arguments: Record<string, unknown> };
  output: Awaited<ReturnType<typeof executeRegisteredTool>>;
  runtime: ToolRuntime;
  context: ToolContext;
};

// 并发范围显式白名单化：read标签并不保证不修改运行态（例如评估会写结果）。
// 只预执行当前就绪的连续只读节点，不跨越写任务，也不绕过依赖或参数校验。
export async function prepareParallelReads(
  runtime: ToolRuntime,
  context: ToolContext,
  availableTools: (runtime: ToolRuntime) => ToolDefinition[],
  prepared: Map<string, PreparedRead>,
) {
  const plan = runtime.executionPlan;
  // 重规划使旧批次失效：不能把旧依赖/旧参数下的预取结果交给新计划。
  for (const [id, value] of prepared)
    if (value.plan !== plan) prepared.delete(id);
  if (
    !plan?.activeId ||
    prepared.has(plan.activeId) ||
    runtime.consultPrebuiltId
  )
    return;
  const ready = plan.nodes.filter(
    (node) =>
      (node.id === plan.activeId || node.status === 'pending') &&
      node.dependsOn.every(
        (id) =>
          plan.nodes.find((parent) => parent.id === id)?.status === 'completed',
      ),
  );
  const jobs: {
    id: string;
    runtime: ToolRuntime;
    context: ToolContext;
    invocation: PreparedRead['invocation'];
  }[] = [];
  let serialReason = '没有至少两个同时就绪且支持并行的任务';
  for (const node of ready) {
    if (prepared.has(node.id)) break;
    if (!node.invocation || !toolMetadata[node.invocation.tool]?.parallelRead) {
      serialReason =
        '任务参数未明确，或工具存在写状态/未经声明的副作用，需要串行处理';
      break;
    }
    const isolated = structuredClone(runtime);
    isolated.executionPlan = {
      nodes: [{ ...structuredClone(node), status: 'running' }],
      activeId: node.id,
      factStart: 0,
    };
    isolated.requestAction = node.action;
    isolated.facts = [];
    isolated.toolsUsed = [];
    isolated.toolErrors = [];
    isolated.exploration = undefined;
    isolated.readOnlyEvaluationTurn = undefined;
    const invocation = directTaskInvocation(isolated, availableTools(isolated));
    if (!invocation) {
      serialReason = '参数、预期目标或当前权限不满足直接执行条件';
      break;
    }
    const isolatedContext: ToolContext = {
      ...context,
      catalog: structuredClone(context.catalog),
      onUpdate: async () => {
        throw Error('并行只读任务禁止写入会话');
      },
      onTaskChange: async () => {
        throw Error('并行只读任务禁止切换会话');
      },
    };
    jobs.push({
      id: node.id,
      runtime: isolated,
      context: isolatedContext,
      invocation,
    });
    if (jobs.length === MAX_PARALLEL_READS) break;
  }
  if (jobs.length < 2 || jobs[0].id !== plan.activeId) {
    plan.parallelDecision = {
      mode: 'serial',
      nodeIds: [plan.activeId],
      reason: serialReason,
    };
    return;
  }
  plan.parallelDecision = {
    mode: 'parallel',
    nodeIds: jobs.map((job) => job.id),
    reason:
      '依赖全部完成；工具声明支持并行只读；参数及权限通过；运行态隔离，无共享写入',
  };
  context.signal?.throwIfAborted();
  (plan.parallelBatches ??= []).push(jobs.map((job) => job.id));
  const results = await Promise.allSettled(
    jobs.map(
      async (job): Promise<PreparedRead> => ({
        plan,
        ...job,
        output: await executeRegisteredTool(
          job.invocation.tool,
          job.invocation.arguments,
          job.context,
          job.runtime,
        ),
      }),
    ),
  );
  // 等待所有分支退出后才交回控制，取消后不合并任何迟到结果。
  context.signal?.throwIfAborted();
  for (const result of results)
    if (result.status === 'rejected') throw result.reason;
  results.forEach((result, index) => {
    if (result.status === 'fulfilled')
      prepared.set(jobs[index].id, result.value);
  });
}

export function consumePreparedRead(
  value: PreparedRead,
  runtime: ToolRuntime,
  context: ToolContext,
) {
  // 仅合并已审阅的只读副产物，绝不将副本的draft/result/task覆盖主状态。
  runtime.facts.push(...value.runtime.facts);
  runtime.toolsUsed.push(...value.runtime.toolsUsed);
  runtime.toolErrors.push(...value.runtime.toolErrors);
  for (const id of value.runtime.approvedPartIds)
    runtime.approvedPartIds.add(id);
  runtime.knowledgeUnavailable ||= value.runtime.knowledgeUnavailable;
  if (value.runtime.failedAttempts) {
    runtime.failedAttempts ??= new Map();
    for (const [key, failure] of value.runtime.failedAttempts)
      runtime.failedAttempts.set(key, failure);
  }
  context.catalog = value.context.catalog;
  return value.output;
}
