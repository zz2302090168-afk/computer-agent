import { type ToolContext } from '../types';

export function assertCurrentTaskUserMessage(
  context: ToolContext,
  messageId: unknown,
) {
  if (typeof messageId !== 'string' || !messageId)
    throw Error('必须提供授权对应的用户消息 ID');
  const message = context.messages.find(
    (item) =>
      item.id === messageId &&
      item.role === 'user' &&
      item.taskId === context.taskId,
  );
  if (!message) throw Error('授权消息不属于当前任务');
  return message;
}
