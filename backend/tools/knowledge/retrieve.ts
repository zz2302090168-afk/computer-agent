import { retrieveKnowledge } from '../../rag/retrieve';
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
        '仅在当前任务明确需要RAG知识文字时检索选型解释或故障排查知识。配置生成、商品搜索、预算计算、兼容性审核、方案保存不得调用。售后传category=support；返回分块知识ID后用update_support保存所选的一步。',
      parameters: objectSchema(
        {
          query: { type: 'string' },
          category: { type: 'string', enum: ['support', 'sales'] },
          topicId: { type: 'string' },
        },
        ['query'],
      ),
    },
  },
  async execute(value, _context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['query', 'category', 'topicId']);
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
    const hits = await retrieveKnowledge(
      _context.embeddingConfig ?? {},
      input.query,
      input.topicId ? 10 : 4,
      input.category as 'support' | 'sales' | undefined,
      input.topicId as string | undefined,
      _context.signal,
    );
    runtime.supportKnowledgeIds ??= new Set();
    for (const hit of hits)
      if (hit.category === 'support') runtime.supportKnowledgeIds.add(hit.id);
    runtime.toolsUsed.push('检索知识');
    return hits;
  },
};
