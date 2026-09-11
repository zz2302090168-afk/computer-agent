import { applyDraft } from '../../agent/conversation-state';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { validateRequirementPatch } from '../requirements';
import { adoptTask, taskRequirementProperties } from './context';
export const createTaskTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'create_task',
      description:
        '创建另一台电脑的独立配机任务，并切换到新任务。不要用于修改当前任务。',
      parameters: objectSchema(
        {
          name: { type: 'string' },
          requirements: objectSchema(taskRequirementProperties),
        },
        ['name'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['name', 'requirements']);
    if (typeof input.name !== 'string' || !input.name.trim())
      throw Error('任务名称不能为空');
    const patch =
      input.requirements === undefined
        ? {}
        : validateRequirementPatch(input.requirements);
    if ('partPreferences' in patch)
      throw Error('创建任务时具体商品必须在新任务中重新查询');
    const draft = applyDraft({}, patch);
    const { createTask } = await import('../../db/tasks'),
      task = await createTask(context.sessionId, input.name, draft);
    await adoptTask(task, context, runtime);
    runtime.toolsUsed.push('创建任务');
    return { taskId: task.id, name: task.name, draft: task.draft };
  },
};
