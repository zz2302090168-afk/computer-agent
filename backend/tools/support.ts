import { supportKnowledge } from '../../knowledge/support';
import type { SupportCase } from '../domain/types';
import {
  isSelfServiceStopped,
  isSupportQuestionId,
  supportQuestionIds,
  type SupportQuestionId,
} from '../support/reply';
import { assertCurrentTaskUserMessage } from './requirements/message';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  supportActions,
  type RegisteredTool,
} from './types';

export { isSelfServiceStopped } from '../support/reply';

export const updateSupportTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_support',
      description:
        '同一任务记录售后问题、用户原话和下一步。先用set_request_action(action=update_support, supportAction=本次action)声明当前消息的售后动作，执行时必须一致，不能从助手回复推导或临时改写。action=continue保存进展，new_issue开始另一故障，stop停止自行操作，resolved仅用户明确反馈恢复，handoff仅用户当前明确要求转人工。停止后本任务售后只允许明确授权的handoff，禁止continue、resolved、new_issue或重复stop；记录人工请求不会解除停止状态。knowledgeId只能选本轮retrieve_knowledge返回且适用于当前现象的step或clarification块，一次一步；不能选择来源说明、停止条件或结论块。Embedding失败时可选同主题本地回退资料。没有适用资料时不填写knowledgeId，可选questionId仅追问已有的澄清问题，不能自行补步骤。questionId与knowledgeId互斥。工具成功后程序直接呈现所选资料或问题，模型最终正文不能添加操作。不修改购机需求或配置，不诊断硬件已损坏。',
      parameters: objectSchema(
        {
          messageId: { type: 'string' },
          action: {
            type: 'string',
            enum: supportActions,
          },
          knowledgeId: { type: 'string' },
          questionId: { type: 'string', enum: supportQuestionIds },
        },
        ['messageId', 'action'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, [
      'messageId',
      'action',
      'knowledgeId',
      'questionId',
    ]);
    if (input.messageId !== context.currentMessageId)
      throw Error('售后更新只能引用当前用户消息');
    const message = assertCurrentTaskUserMessage(context, input.messageId);
    if (!supportActions.some((action) => action === input.action))
      throw Error('售后操作无效');
    const selfServiceStopped = isSelfServiceStopped(runtime.draft.support);
    if (selfServiceStopped && input.action !== 'handoff')
      throw Error(
        '当前任务已停止自行排查，售后仅允许记录用户明确提出的转人工请求；不能继续排查、标记恢复或新建故障解除停止状态。',
      );
    const request = runtime.supportRequest;
    if (
      runtime.requestAction !== 'update_support' ||
      !request ||
      request.sourceMessageId !== context.currentMessageId ||
      request.taskId !== context.taskId ||
      request.taskId !== runtime.task.id ||
      request.action !== input.action
    )
      throw Error(
        '售后操作必须匹配当前消息和任务已记录的supportAction，不能临时改为转人工、已恢复或其他售后动作',
      );
    const previous =
      input.action === 'new_issue' ? undefined : runtime.draft.support;
    if (
      runtime.supportDelivery?.messageId === context.currentMessageId &&
      runtime.supportDelivery.taskId === context.taskId &&
      runtime.supportDelivery.knowledgeId &&
      runtime.supportDelivery.knowledgeId !== input.knowledgeId
    )
      throw Error('本轮已选定一个排查步骤，请等待用户反馈后再选择下一步');
    if (input.knowledgeId !== undefined && input.questionId !== undefined)
      throw Error('排查步骤和澄清问题一次只能选择一项');
    let questionId: SupportQuestionId | undefined;
    if (input.questionId !== undefined) {
      if (!['continue', 'new_issue'].includes(String(input.action)))
        throw Error('停止、恢复或人工请求不能附带澄清问题');
      if (!isSupportQuestionId(input.questionId))
        throw Error('请选择已有的售后澄清问题');
      questionId = input.questionId;
    }
    let stepId: string | undefined;
    if (input.knowledgeId !== undefined) {
      if (!['continue', 'new_issue'].includes(String(input.action)))
        throw Error('停止、恢复或人工请求不能附带排查操作');
      const evidence =
        typeof input.knowledgeId === 'string'
          ? runtime.supportEvidence?.get(input.knowledgeId)
          : undefined;
      const knowledge = supportKnowledge.find(
        (item) => item.id === input.knowledgeId,
      );
      if (
        !knowledge ||
        !evidence ||
        evidence.taskId !== context.taskId ||
        evidence.messageId !== context.currentMessageId
      )
        throw Error('请先检索并选择本轮返回的售后知识ID');
      if (
        knowledge.supportKind !== 'step' &&
        knowledge.supportKind !== 'clarification'
      )
        throw Error(
          '该知识块仅为背景说明，不能作为排查步骤；请选择适用的步骤或先问块',
        );
      stepId = knowledge.id;
    }
    const status: SupportCase['status'] =
      input.action === 'handoff'
        ? 'handoff_requested'
        : input.action === 'resolved'
          ? 'resolved'
          : input.action === 'stop'
            ? 'stopped'
            : 'active';
    const history = [...(previous?.history ?? [])];
    // 同一条消息的重复工具调用不重复记录用户报告。
    const report = {
      messageId: context.currentMessageId,
      report: message.content,
      ...(stepId ? { stepId } : {}),
    };
    if (history.at(-1)?.messageId === context.currentMessageId)
      history[history.length - 1] = report;
    else history.push(report);
    const support: SupportCase = {
      status,
      ...(input.action === 'stop' || selfServiceStopped
        ? { selfServiceStopped: true }
        : {}),
      symptom: previous?.symptom ?? message.content,
      ...(stepId ? { currentStepId: stepId } : {}),
      history: history.slice(-30),
    };
    const draft = { ...runtime.draft, support };
    await context.onUpdate?.('support', draft, runtime.result);
    runtime.draft = draft;
    runtime.supportDelivery = {
      taskId: context.taskId,
      messageId: context.currentMessageId,
      action: request.action,
      ...(stepId ? { knowledgeId: stepId } : {}),
      ...(questionId ? { questionId } : {}),
    };
    runtime.exploration = undefined;
    runtime.toolsUsed.push('记录售后排查');
    return {
      support,
      ...(questionId ? { questionId } : {}),
      ...(input.action === 'handoff'
        ? {
            handoff: {
              requestRecorded: true,
              dispatched: false,
              notice:
                '仅在当前任务记录了人工协助请求。本系统没有人工转接、通知客服或创建工单的接口，未通知任何客服；不能承诺人工会联系用户或让用户等待接入。',
            },
          }
        : {}),
      knowledge: stepId
        ? supportKnowledge.find((item) => item.id === stepId)
        : null,
    };
  },
};
