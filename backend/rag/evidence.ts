import { retrieveKnowledge } from './retrieve';

export const knowledgeUnavailable =
  '知识检索不可用；仅能说明当前数据库已记录的规格或追问需求，不能给出性能比较、测试结论或补充未记录的厂家参数。';

export async function retrieveEvidence(
  ...args: Parameters<typeof retrieveKnowledge>
) {
  try {
    const evidence = await retrieveKnowledge(...args);
    return {
      evidence,
      knowledgeStatus: evidence.length
        ? ('available' as const)
        : ('unavailable' as const),
      knowledgeNotice: evidence.length ? '' : knowledgeUnavailable,
      knowledgeFailure: evidence.length ? undefined : ('no_match' as const),
    };
  } catch {
    // 用户取消不能伪装成知识降级后继续保存结果。
    args[5]?.throwIfAborted();
    return {
      evidence: [],
      knowledgeStatus: 'unavailable' as const,
      knowledgeNotice: knowledgeUnavailable,
      knowledgeFailure: 'service_error' as const,
    };
  }
}
