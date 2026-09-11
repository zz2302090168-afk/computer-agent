import { applyDraft } from '../../agent/conversation-state';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { validateRequirementPatch } from '../requirements';
import { adoptTask, taskRequirementProperties } from './context';
export const resetCurrentTaskTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'reset_current_task',
      description:
        '仅重置当前配机任务，建立新的上下文边界。可在 requirements 中同时写入本句明确的新需求；不得沿用旧商品、授权或方案。',
      parameters: objectSchema({
        requirements: objectSchema(taskRequirementProperties),
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['requirements']);
    const patch =
      input.requirements === undefined
        ? {}
        : validateRequirementPatch(input.requirements);
    if ('partPreferences' in patch) throw Error('重置后具体商品必须重新查询');
    const draft = applyDraft({}, patch);
    const { resetTask } = await import('../../db/tasks'),
      task = await resetTask(context.sessionId, runtime.task, draft);
    await adoptTask(task, context, runtime, true);
    runtime.toolsUsed.push('重置当前任务');
    return { taskId: task.id, draft: task.draft, contextBoundaryReset: true };
  },
};
