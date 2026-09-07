import {
  applyDraft,
  inferExplicitPatch,
  type Draft,
} from '../../agent/conversation-state';
import type { TaskSummary } from '../../domain/types';
import type { PcTask } from '../../domain/types';

export type TaskCommand =
  | { type: 'reset'; draft: Draft }
  | { type: 'create'; name: string; draft: Draft }
  | { type: 'switch'; taskId: string }
  | { type: 'clarify'; reply: string }
  | null;

// 任务切换是会话级操作，不注册给模型；路由仍需用 sessionId 执行数据库归属校验。
export function detectTaskCommand(
  message: string,
  tasks: TaskSummary[],
): TaskCommand {
  // 全量重置必须先于普通需求合并；只处理明确的整台重置指令。
  if (
    !/不要|别|不需要|只.*(?:CPU|显卡|内存|主板|电源|机箱|硬盘|散热)/i.test(
      message,
    ) &&
    /(?:全部|所有|这台).*(?:重新设置|重置|重来|重新来)|从头配(?:置)?(?:主机|电脑)?|(?:重新设置|重置).*(?:全部|所有)需求/.test(
      message,
    )
  ) {
    const remainder = message.replace(
      /^.*?(?:重新设置需求|重新设置|重置需求|重置|重新来|重来|从头配|重新配)[，,。\s]*/,
      '',
    );
    return {
      type: 'reset',
      draft: applyDraft({}, inferExplicitPatch(remainder)),
    };
  }
  if (/(?:另外|再|还要).*?(?:配|装).*?(?:一台|主机|电脑)/.test(message)) {
    const patch = inferExplicitPatch(message),
      purpose = /办公|文档/.test(message)
        ? '办公'
        : /游戏/.test(message)
          ? '游戏'
          : undefined;
    return {
      type: 'create',
      name: `${/朋友/.test(message) ? '朋友的' : ''}${purpose ?? '新'}主机`,
      draft: { ...patch, ...(purpose ? { purpose } : {}) },
    };
  }
  if (!/回到|切换到|继续.*(?:那台|任务)/.test(message)) return null;
  const keyword = /办公/.test(message)
    ? '办公'
    : /游戏/.test(message)
      ? '游戏'
      : '';
  const matches = tasks.filter(
    (task) =>
      !keyword || task.name.includes(keyword) || task.purpose === keyword,
  );
  if (matches.length === 1) return { type: 'switch', taskId: matches[0]!.id };
  return {
    type: 'clarify',
    reply: matches.length
      ? '有多个匹配任务，请告诉我任务名称。'
      : '没有找到对应任务，请从任务列表选择。',
  };
}

export async function executeTaskCommand(
  sessionId: string,
  currentTask: PcTask,
  message: string,
  tasks: TaskSummary[],
) {
  const command = detectTaskCommand(message, tasks);
  if (!command) return { task: currentTask, changed: false as const };
  if (command.type === 'clarify')
    return { task: currentTask, changed: false as const, reply: command.reply };
  const { createTask, resetTask, switchTask } = await import('../../db/tasks');
  // 纯意图识别不依赖 Worker 运行环境，只有执行写入时才加载数据库。
  // 所有数据操作都携带当前 sessionId，底层查询不会只凭 taskId 访问其他会话。
  if (command.type === 'create')
    return {
      task: await createTask(sessionId, command.name, command.draft),
      changed: true as const,
    };
  if (command.type === 'switch')
    return {
      task: await switchTask(sessionId, command.taskId),
      changed: true as const,
    };
  return {
    task: await resetTask(sessionId, currentTask, command.draft),
    changed: true as const,
    reset: true as const,
  };
}
