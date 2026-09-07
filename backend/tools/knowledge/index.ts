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
      description: '检索兼容性、选型取舍和预算规则知识。',
      parameters: objectSchema({ query: { type: 'string' } }, ['query']),
    },
  },
  async execute(value, _context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['query']);
    if (typeof input.query !== 'string' || !input.query.trim())
      throw Error('知识查询内容不能为空');
    runtime.toolsUsed.push('检索知识');
    return retrieveKnowledge(input.query, 4);
  },
};
