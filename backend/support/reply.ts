import { supportKnowledge } from '../../knowledge/support';
import type { SupportCase } from '../domain/types';
import type { ToolContext, ToolRuntime } from '../tools/types';

export const supportQuestions = {
  device: '请说明这是台式机还是笔记本，以及实际使用的电脑型号。',
  symptom:
    '请描述当前能观察到的现象，并提供屏幕提示原文；没有提示时直接说明即可。',
  timing: '异常发生在按电源键后、出现开机画面后，还是进入系统后？',
  changes:
    '最后一次正常使用是什么时候？异常出现前更换过设备、软件或连接方式吗？',
  previous_checks:
    '已经尝试过哪些检查？请分别说明操作和当时的结果，暂时不用重复操作。',
  hazards:
    '是否出现过焦味、烟雾、火花、进液、异常高温、电池鼓包或重要数据丢失的迹象？只描述已观察到的情况，不用再次开机验证。',
} as const;
export type SupportQuestionId = keyof typeof supportQuestions;
export const supportQuestionIds = Object.keys(supportQuestions);
export function isSupportQuestionId(
  value: unknown,
): value is SupportQuestionId {
  return typeof value === 'string' && Object.hasOwn(supportQuestions, value);
}

export function isSelfServiceStopped(support?: SupportCase) {
  return support?.selfServiceStopped === true || support?.status === 'stopped';
}

// 只读取本轮程序事实；不检查模型正文，也不从用户措辞推断意图。
export function renderSupportReply(
  runtime: ToolRuntime,
  context: ToolContext,
): string | undefined {
  const current = (value?: { taskId: string; messageId: string }) =>
    value?.taskId === context.taskId &&
    value.taskId === runtime.task.id &&
    value.messageId === context.currentMessageId;
  if (
    runtime.requestAction !== 'update_support' &&
    !(runtime.requestAction === 'other' && runtime.otherTopic === 'support') &&
    !current(runtime.supportRetrieval) &&
    !current(runtime.supportDelivery)
  )
    return undefined;

  const delivery = current(runtime.supportDelivery)
    ? runtime.supportDelivery
    : undefined;
  const support = runtime.draft.support;
  const stopped = isSelfServiceStopped(support);
  if (delivery?.action === 'handoff' && support?.status === 'handoff_requested')
    return (
      '已记录你的人工协助请求。当前系统没有实际转接、通知客服或创建工单的接口，尚未联系任何客服。' +
      (stopped ? '\n\n本次任务继续保持停止自行排查。' : '')
    );
  if (stopped)
    return '本次任务已停止自行排查，请勿继续操作或再次通电验证。需要人工协助时，可以明确提出请求；当前系统只能记录请求，无法实际接通客服。';
  if (delivery?.action === 'resolved' && support?.status === 'resolved')
    return '已记录你反馈的问题恢复。恢复使用不等于已经确认故障原因。';

  if (delivery?.knowledgeId) {
    const evidence = runtime.supportEvidence?.get(delivery.knowledgeId);
    const knowledge = supportKnowledge.find(
      (item) => item.id === delivery.knowledgeId,
    );
    if (
      current(evidence) &&
      support?.currentStepId === delivery.knowledgeId &&
      support.history.at(-1)?.messageId === context.currentMessageId &&
      knowledge &&
      (knowledge.supportKind === 'step' ||
        knowledge.supportKind === 'clarification')
    )
      return (
        (evidence?.source === 'local'
          ? '在线知识检索暂不可用，以下使用本地已有的通用排查资料，未经具体厂家逐项验证。\n\n'
          : '') + knowledge.content
      );
  }

  const question = delivery?.questionId ?? 'symptom';
  const retrieval = current(runtime.supportRetrieval)
    ? runtime.supportRetrieval
    : undefined;
  const notice =
    retrieval?.status === 'failed'
      ? '知识检索不可用，当前没有可用的排查步骤，先补充必要信息。'
      : retrieval?.status === 'empty' || retrieval?.status === 'available'
        ? '当前尚未选定适用的排查步骤，先补充必要信息。'
        : runtime.requestAction === 'other'
          ? '当前没有新增排查步骤或人工请求。需要人工协助时可以明确提出；系统只能记录请求，无法实际转接。'
          : delivery
            ? '已记录你的反馈，先补充必要信息。'
            : '本次售后反馈尚未成功记录，暂不提供新的排查步骤。';
  return `${notice}\n\n${supportQuestions[question]}`;
}
