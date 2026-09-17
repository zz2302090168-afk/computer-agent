import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const answerKnowledgeTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'answer_knowledge',
      description:
        '仅用于本轮knowledgeOnly=true的纯售前知识问答。检索后选择真正回答用户问题的知识块ID，程序展示这些块的完整原文与来源，不接收或补写事实正文。只选必要且相关的块，不因排名高就全部选择。覆盖不足用partial；无支持用unsupported及空ID数组，不能引用历史轮次ID。完成后无需再次复述正文。',
      parameters: objectSchema(
        {
          knowledgeIds: {
            type: 'array',
            maxItems: 4,
            items: { type: 'string' },
          },
          coverage: {
            type: 'string',
            enum: ['complete', 'partial', 'unsupported'],
          },
        },
        ['knowledgeIds', 'coverage'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['knowledgeIds', 'coverage']);
    const evidence = runtime.knowledgeEvidence;
    if (
      runtime.requestAction !== 'retrieve_knowledge' ||
      !runtime.knowledgeOnly ||
      !evidence ||
      evidence.taskId !== context.taskId ||
      evidence.messageId !== context.currentMessageId
    )
      throw Error('请先在本轮纯知识问答中检索资料，不能使用历史证据');
    if (
      !Array.isArray(input.knowledgeIds) ||
      input.knowledgeIds.length > 4 ||
      input.knowledgeIds.some((id) => typeof id !== 'string') ||
      new Set(input.knowledgeIds).size !== input.knowledgeIds.length
    )
      throw Error('knowledgeIds须为最多4个不重复的本轮知识ID');
    if (
      typeof input.coverage !== 'string' ||
      !['complete', 'partial', 'unsupported'].includes(input.coverage)
    )
      throw Error('知识覆盖状态无效');
    if (
      input.coverage === 'unsupported'
        ? input.knowledgeIds.length !== 0
        : input.knowledgeIds.length === 0
    )
      throw Error('有支持时必须选择知识ID，无支持时必须使用空ID数组');
    const blocks = input.knowledgeIds.map((id) => {
      const block = evidence.blocks.get(id);
      if (!block) throw Error('所选知识ID未在本轮检索中返回');
      return block;
    });
    const displayReply =
      input.coverage === 'unsupported'
        ? '本次检索资料不足以回答这个问题，不能据此补充未经核实的事实。'
        : [
            ...blocks.map((block) =>
              [
                block.content,
                block.source ? `来源：[${block.title}](${block.source})` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            ),
            input.coverage === 'partial'
              ? '以上是本次资料支持的部分，其余问题本次资料未说明。'
              : '',
          ]
            .filter(Boolean)
            .join('\n\n');
    runtime.knowledgeAnswerReady = true;
    return {
      knowledgeIds: input.knowledgeIds,
      coverage: input.coverage,
      displayReply,
    };
  },
};
