import { clearComputedSelection } from './state';
import {
  applyDraft,
  changesRecommendation,
} from '../../agent/conversation-state';
import { objectSchema, parseObject, type RegisteredTool } from '../types';
import { requirementPatchProperties, validateRequirementPatch } from './schema';
export const updateRequirementsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_requirements',
      description:
        '把用户明确表达的预算、用途、购买方式、颜色、品牌、系列或具体商品更新到当前任务。5060 等芯片名称属于 seriesPreferences；只有用户说出品牌和完整版本时才把精确查询所得 ID 写入 partPreferences。',
      parameters: objectSchema({
        ...requirementPatchProperties,
        rebuild: {
          type: 'boolean',
          description:
            '仅用户明确要求整体重新配置时设true；已有方案的局部配件修改应调用replace_parts',
        },
      }),
    },
  },
  async execute(value, context, runtime) {
    const { rebuild, ...values } = parseObject(value);
    if (rebuild !== undefined && typeof rebuild !== 'boolean')
      throw Error('rebuild必须为布尔值');
    const patch = validateRequirementPatch(values);
    if (
      runtime.result?.plans.length &&
      !rebuild &&
      [
        'partPreferences',
        'seriesPreferences',
        'brandPreferences',
        'partColors',
      ].some((key) => key in patch)
    )
      throw Error(
        '当前已有方案，配件级修改请直接调用replace_parts，保留其他配件；只有明确要求整套重配时才使用rebuild=true',
      );
    if (
      patch.partPreferences &&
      typeof patch.partPreferences === 'object' &&
      !Array.isArray(patch.partPreferences)
    )
      for (const [category, id] of Object.entries(patch.partPreferences)) {
        if (typeof id !== 'string' || !id) throw Error('指定型号商品 ID 无效');
        if (
          !runtime.approvedPartIds.has(id) ||
          !context.catalog.parts.some(
            (part) => part.id === id && part.category === category,
          )
        )
          throw Error('指定型号尚未通过当前轮次的精确目录查询');
      }
    const previous = runtime.draft,
      next = applyDraft(previous, patch),
      changed = changesRecommendation(previous, next);
    runtime.draft = changed ? clearComputedSelection(next) : next;
    if (changed) {
      runtime.result = null;
      await context.onUpdate?.('requirements', runtime.draft, null);
    }
    runtime.toolsUsed.push('记录需求');
    return { draft: runtime.draft, recommendationExpired: changed };
  },
};
