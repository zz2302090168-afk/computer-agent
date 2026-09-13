import type { PcTask } from '../backend/domain/types';
import type { ChatState } from '../backend/agent/conversation';
import type { PlanActionResponse } from '../backend/api/plan-actions';

// 聊天与恢复请求仍更新消息；迟到的旧任务快照不能回滚已保存的配置操作。
export function applyWorkspaceResponse(
  state: ChatState,
  response: ChatState,
): ChatState {
  const current = state.task;
  if (
    !current ||
    state.currentTaskId !== response.currentTaskId ||
    response.task?.id !== current.id ||
    response.task.version >= current.version
  )
    return response;

  const currentSummary = {
    id: current.id,
    name: current.name,
    version: current.version,
    updatedAt: current.updatedAt,
    budget: state.draft.budget,
    purpose: state.draft.purpose,
  };
  const incomingTasks = response.tasks ?? state.tasks ?? [];
  const tasks = incomingTasks.some((task) => task.id === current.id)
    ? incomingTasks.map((task) =>
        task.id === current.id ? currentSummary : task,
      )
    : [...incomingTasks, currentSummary];
  return {
    ...response,
    draft: state.draft,
    result: state.result,
    task: current,
    tasks,
  };
}

// 完整替换已保存的结果；缺失字段表示服务端已清除，不能与旧方案合并。
export function applyPlanActionResponse(
  state: ChatState,
  response: PlanActionResponse,
): ChatState {
  if (
    state.currentTaskId !== response.taskId ||
    state.task?.id !== response.taskId ||
    response.version < state.task.version
  )
    return state;

  const { taskId, version, updatedAt, draft, ...result } = response;
  return {
    ...state,
    draft,
    result,
    task: { ...state.task, draft, result, version, updatedAt, issues: [] },
    tasks: state.tasks?.map((task) =>
      task.id === taskId
        ? {
            ...task,
            version,
            updatedAt,
            budget: draft.budget,
            purpose: draft.purpose,
          }
        : task,
    ),
  };
}

// 需求流仅更新当前任务的工作区，不覆盖正在显示的本轮用户消息。
export function applyRequirementSnapshot(
  state: ChatState,
  task: PcTask,
): ChatState {
  if (
    state.currentTaskId !== task.id ||
    (state.task && task.version < state.task.version)
  )
    return state;
  return { ...state, draft: task.draft, result: task.result, task };
}
