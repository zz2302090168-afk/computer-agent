import type { PcTask } from '../../domain/types';
import { type ToolContext, type ToolRuntime } from '../types';
import { requirementPatchProperties } from '../requirements';

export const taskRequirementProperties = Object.fromEntries(
  Object.entries(requirementPatchProperties).filter(
    ([key]) => key !== 'partPreferences',
  ),
);

export async function adoptTask(
  task: PcTask,
  context: ToolContext,
  runtime: ToolRuntime,
  removePrevious = false,
) {
  const previousTaskId = runtime.task.id;
  runtime.task = task;
  runtime.draft = task.draft;
  runtime.result = task.result;
  runtime.contextChanged = true;
  context.taskId = task.id;
  // 工具切换后，下一轮模型看到的任务列表也必须同步，避免继续引用旧任务摘要。
  context.tasks = [
    {
      id: task.id,
      name: task.name,
      version: task.version,
      updatedAt: task.updatedAt,
      purpose: task.draft.purpose,
      budget: task.draft.budget,
    },
    ...context.tasks.filter(
      (item) =>
        item.id !== task.id && (!removePrevious || item.id !== previousTaskId),
    ),
  ];
  const current = context.messages.find(
    (message) => message.id === context.currentMessageId,
  );
  if (current) current.taskId = task.id;
  await context.onTaskChange(task);
}
