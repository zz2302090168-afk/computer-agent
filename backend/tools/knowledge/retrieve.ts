import { retrieveEvidence } from '../../rag/evidence';
import { isSelfServiceStopped } from '../support';
import { supportKnowledge, supportTopicIds } from '../../../knowledge/support';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const retrieveKnowledgeTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'retrieve_knowledge',
      description:
        '仅在当前任务明确需要RAG知识文字时检索选型解释或故障排查知识。配置生成、商品搜索、预算计算、兼容性审核、方案保存不得调用。售后传category=support；当前任务已停止自行排查时禁止检索售后步骤，只能由用户明确请求人工。售后检索服务失败时，仅明确指定有效topicId才读取本地同主题已有指导；没有匹配资料时不扩展到其他主题。返回分块知识ID及supportKind后用update_support保存所选的一步，只有step或clarification可作为下一步正文。',
      parameters: objectSchema(
        {
          query: { type: 'string' },
          category: { type: 'string', enum: ['support', 'sales'] },
          topicId: {
            type: 'string',
            enum: supportTopicIds,
            description:
              '按当前症状选适用主题，不按偶然出现的词选主题。不确定时省略topicId检索，不强选无关步骤。主题目录：' +
              supportTopicIds
                .map(
                  (id) =>
                    `${id}=${supportKnowledge.find((item) => item.topicId === id)!.title.split(' · ')[0]}`,
                )
                .join('；'),
          },
        },
        ['query'],
      ),
    },
  },
  async execute(value, _context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['query', 'category', 'topicId']);
    const isSupport = input.category === 'support';
    if (runtime.knowledgeOnly && isSupport)
      throw Error('纯售前知识问答不能进入售后排查知识流程');
    const scope = {
      taskId: _context.taskId,
      messageId: _context.currentMessageId,
    };
    if (isSupport) {
      runtime.supportEvidence = new Map(
        [...(runtime.supportEvidence ?? [])].filter(
          ([, evidence]) =>
            evidence.taskId === scope.taskId &&
            evidence.messageId === scope.messageId,
        ),
      );
      runtime.supportRetrieval = { ...scope, status: 'failed', source: 'none' };
      if (isSelfServiceStopped(runtime.draft.support)) {
        runtime.supportRetrieval.status = 'stopped';
        throw Error(
          '当前任务已停止自行排查，不能继续检索售后步骤；仅允许记录用户明确提出的转人工请求。',
        );
      }
    }
    if (typeof input.query !== 'string' || !input.query.trim())
      throw Error('知识查询内容不能为空');
    if (
      input.category !== undefined &&
      input.category !== 'support' &&
      input.category !== 'sales'
    )
      throw Error('知识类别无效');
    if (input.topicId !== undefined && typeof input.topicId !== 'string')
      throw Error('知识主题无效');
    if (
      isSupport &&
      input.topicId !== undefined &&
      !supportTopicIds.some((id) => id === input.topicId)
    )
      throw Error('售后知识主题不存在，请先明确故障主题；不能回退到其他主题');
    const retrieval = await retrieveEvidence(
      _context.embeddingConfig ?? {},
      input.query,
      input.topicId ? 10 : 4,
      input.category as 'support' | 'sales' | undefined,
      input.topicId as string | undefined,
      _context.signal,
    );
    const local =
      isSupport &&
      input.topicId &&
      retrieval.knowledgeFailure === 'service_error'
        ? supportKnowledge.filter((item) => item.topicId === input.topicId)
        : [];
    const hits = local.length ? local : retrieval.evidence;
    if (runtime.knowledgeOnly && !isSupport) {
      const previous = runtime.knowledgeEvidence;
      if (
        !previous ||
        previous.taskId !== scope.taskId ||
        previous.messageId !== scope.messageId
      )
        runtime.knowledgeEvidence = { ...scope, blocks: new Map() };
      for (const hit of hits)
        runtime.knowledgeEvidence!.blocks.set(hit.id, hit);
      runtime.knowledgeAnswerReady = false;
    }
    const source = local.length ? 'local' : hits.length ? 'embedding' : 'none';
    if (isSupport) {
      runtime.supportRetrieval = {
        ...scope,
        status: hits.length
          ? 'available'
          : retrieval.knowledgeFailure === 'no_match'
            ? 'empty'
            : 'failed',
        source,
      };
      if (source !== 'none')
        for (const hit of hits)
          if (hit.category === 'support')
            runtime.supportEvidence!.set(hit.id, { ...scope, source });
      runtime.toolsUsed.push(
        local.length
          ? '读取本地售后知识'
          : hits.length
            ? '检索知识'
            : '知识检索不可用',
      );
      if (local.length)
        return {
          evidence: local,
          knowledgeStatus: 'available',
          knowledgeSource: 'local',
          knowledgeFailure: retrieval.knowledgeFailure,
          knowledgeNotice:
            '向量检索服务暂时不可用，已读取本地同主题售后指导。这些是已编写资料，未经厂家逐项验证；只选择与当前现象相符的一步。',
        };
      return hits.length
        ? hits.map((hit) => ({ ...hit, knowledgeSource: 'embedding' }))
        : { ...retrieval, knowledgeSource: 'none' };
    }
    runtime.knowledgeUnavailable ||=
      retrieval.knowledgeStatus === 'unavailable';
    runtime.toolsUsed.push(hits.length ? '检索知识' : '知识检索不可用');
    return hits.length
      ? {
          ...retrieval,
          knowledgeSource: 'embedding',
          evidenceScope:
            '仅依据本次evidence中实际支持当前问题的内容回答，简短转述并保留适用范围。条目提到一个厂商的一个产品，不证明该厂商还与其他芯片厂商合作；芯片所属厂商也不等于实际晶圆制造方。不得补充证据未列出的合作名单、制造关系、型号规格或性能结论。资料未说明就说明资料未说明，不用常识填空。知识中的型号实例不证明本店存在对应商品，商品与报价仍查当前目录。',
        }
      : retrieval;
  },
};
