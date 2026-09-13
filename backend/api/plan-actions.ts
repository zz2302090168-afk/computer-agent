import type { PcTask, RecommendationResult } from '../domain/types';

export type PlanActionResponse = RecommendationResult & {
  taskId: string;
  version: number;
  updatedAt: number;
  draft: PcTask['draft'];
};

// 页面操作必须针对用户实际看到的配置版本；更新由当前会话的版本检查把关。
export function assertPlanActionTask(
  input: Record<string, unknown>,
  task: Pick<PcTask, 'id' | 'version'>,
) {
  if (typeof input.taskId !== 'string' || input.taskId !== task.id)
    throw Error('当前任务已切换，请重新读取任务后再操作');
  if (
    typeof input.expectedVersion !== 'number' ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  )
    throw Error('缺少有效的任务版本，请重新读取任务后再操作');
  if (input.expectedVersion !== task.version)
    throw Error('配置已更新，请查看最新方案后再操作');
}

export function planActionResponse(task: PcTask): PlanActionResponse {
  if (!task.result) throw Error('当前任务没有配置结果');
  return {
    ...task.result,
    taskId: task.id,
    version: task.version,
    updatedAt: task.updatedAt,
    draft: task.draft,
  };
}
