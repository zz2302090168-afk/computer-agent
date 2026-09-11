import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { assertCurrentTaskUserMessage } from '../requirements';
import { adoptTask } from './context';
export const undoLastChangeTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'undo_last_change',
      description:
        '用户明确要求撤回、撤销、恢复上一次修改时使用。恢复当前任务上次操作前的需求与方案，按最新数据库审核；不得用重新推荐代替撤回。',
      parameters: objectSchema({ sourceMessageId: { type: 'string' } }, [
        'sourceMessageId',
      ]),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['sourceMessageId']);
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('撤回必须依据当前用户消息');
    if (
      runtime.facts.some(
        (fact) => fact.tool === 'undo_last_change' && !fact.failed,
      )
    )
      throw Error('本条消息已撤回一次；不得重复撤回更早的修改');
    const { getTask, undoTask } = await import('../../db/tasks');
    const current = await getTask(context.sessionId, context.taskId);
    const restored = await undoTask(
      context.sessionId,
      context.taskId,
      current.version,
    );
    await adoptTask(restored, context, runtime);
    runtime.exploration = {
      status:
        restored.result?.plans[0]?.budget.confirmable === false
          ? 'reference'
          : 'ready',
      reason: '已撤回上一次更改；恢复方案已按当前目录审核，未重新选型。',
    };
    return {
      draft: restored.draft,
      result: restored.result,
      version: restored.version,
    };
  },
};
