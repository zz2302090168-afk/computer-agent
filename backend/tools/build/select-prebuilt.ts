import { completeRequirements } from '../../agent/conversation-state';
import { selectPrebuilt } from '../../services/recommend';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';
import { saveSelectedPlan } from './selection';
export const selectPrebuiltTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'select_prebuilt',
      description:
        '提交查询所得整机ID；按最新数据库核对整机商品、八类构成、颜色和预算后保存，不执行DIY配件兼容性审核。失败时查询下一候选，不能自行拆换商家整机配件。',
      parameters: objectSchema({ prebuiltId: { type: 'string' } }, [
        'prebuiltId',
      ]),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['prebuiltId']);
    if (typeof input.prebuiltId !== 'string') throw Error('整机ID无效');
    context.catalog = await context.reloadCatalog();
    const requirements = completeRequirements(runtime.draft);
    const plan = selectPrebuilt(
      input.prebuiltId,
      requirements,
      context.catalog.parts,
      context.catalog.prebuilts,
    );
    return saveSelectedPlan(plan, requirements, context, runtime);
  },
};
