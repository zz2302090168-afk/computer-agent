import { supportKnowledge } from '../../knowledge/support';
import type { SupportCase } from '../domain/types';
import { assertCurrentTaskUserMessage } from './requirements/message';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from './types';

// 否定、假设和入口咨询不能触发人工请求；这个兜底有意保守。
export function explicitlyRequestsHuman(text: string) {
  if (/(如果|假如|要是|不行再|不行就)/.test(text)) return false;
  if (/[吗？?]/.test(text) && !/(帮我|给我|替我)/.test(text)) return false;
  return text
    .split(/[，,。！!；;\n]/)
    .some((clause) =>
      /^(?:(?:请|麻烦|劳驾|现在|直接|马上|立即|那就|我要|我想|我需要|帮我|给我|替我|可以|能不能|能否|可不可以)\s*)*(?:转(?:接|到|给)?\s*人工(?:客服)?|找(?:个|一位)?人工(?:客服)?|让人工(?:客服)?接手)(?:一下|吧|谢谢|好吗|可以吗|吗[？?])?[？?]?$/.test(
        clause.trim(),
      ),
    );
}

export const updateSupportTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_support',
      description:
        '同一任务记录售后问题、用户原话和下一步。action=continue保存进展，new_issue开始另一故障，stop暂停自行操作，resolved仅用户明确反馈恢复，handoff仅用户当前明确要求转人工。knowledgeId只能选本轮retrieve_knowledge返回的售后块，一次一步。不修改购机需求或配置，不诊断硬件已损坏。',
      parameters: objectSchema(
        {
          messageId: { type: 'string' },
          action: {
            type: 'string',
            enum: ['continue', 'new_issue', 'stop', 'resolved', 'handoff'],
          },
          knowledgeId: { type: 'string' },
        },
        ['messageId', 'action'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['messageId', 'action', 'knowledgeId']);
    if (input.messageId !== context.currentMessageId)
      throw Error('售后更新只能引用当前用户消息');
    const message = assertCurrentTaskUserMessage(context, input.messageId);
    if (
      !['continue', 'new_issue', 'stop', 'resolved', 'handoff'].includes(
        String(input.action),
      )
    )
      throw Error('售后操作无效');
    if (input.action === 'handoff' && !explicitlyRequestsHuman(message.content))
      throw Error(
        '当前消息没有明确转人工请求；不得自动转人工，继续排查或询问具体意图',
      );
    if (
      input.action === 'resolved' &&
      (!/(好了|恢复正常|问题解决|解决了|正常了|修好了)/.test(message.content) ||
        /(没好|没解决|未解决|还没|如果|假如|不正常|没(?:有)?恢复|是不是|是否|吗|？|\?)/.test(
          message.content,
        ))
    )
      throw Error('用户尚未明确反馈问题恢复，不能标记已解决');
    const previous =
      input.action === 'new_issue' ? undefined : runtime.draft.support;
    if (
      previous?.status === 'stopped' &&
      input.action === 'continue' &&
      input.knowledgeId
    )
      throw Error(
        '当前已暂停自行操作；不能继续发送操作步骤。请先核对危险是否解除，新的问题用new_issue记录。',
      );
    let stepId: string | undefined;
    if (input.knowledgeId !== undefined) {
      if (!['continue', 'new_issue'].includes(String(input.action)))
        throw Error('停止、恢复或人工请求不能附带排查操作');
      if (
        typeof input.knowledgeId !== 'string' ||
        !runtime.supportKnowledgeIds?.has(input.knowledgeId) ||
        !supportKnowledge.some((item) => item.id === input.knowledgeId)
      )
        throw Error('请先检索并选择本轮返回的售后知识ID');
      stepId = input.knowledgeId;
    }
    const status: SupportCase['status'] =
      input.action === 'handoff'
        ? 'handoff_requested'
        : input.action === 'resolved'
          ? 'resolved'
          : input.action === 'stop' || previous?.status === 'stopped'
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
      symptom: previous?.symptom ?? message.content,
      ...(stepId ? { currentStepId: stepId } : {}),
      history: history.slice(-30),
    };
    const draft = { ...runtime.draft, support };
    await context.onUpdate?.('support', draft, runtime.result);
    runtime.draft = draft;
    runtime.exploration = undefined;
    runtime.toolsUsed.push('记录售后排查');
    return {
      support,
      knowledge: stepId
        ? supportKnowledge.find((item) => item.id === stepId)
        : null,
    };
  },
};
