import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { adoptTask } from './context';
export const switchTaskTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'switch_task',
      description:
        '切换到当前会话已有任务。taskId 必须来自系统提供的任务列表。',
      parameters: objectSchema({ taskId: { type: 'string' } }, ['taskId']),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['taskId']);
    if (typeof input.taskId !== 'string' || !input.taskId)
      throw Error('任务 ID 无效');
    const { switchTask } = await import('../../db/tasks'),
      task = await switchTask(context.sessionId, input.taskId);
    await adoptTask(task, context, runtime);
    runtime.toolsUsed.push('切换任务');
    return {
      taskId: task.id,
      name: task.name,
      draft: task.draft,
      hasPlan: !!task.result?.plans.length,
    };
  },
};
