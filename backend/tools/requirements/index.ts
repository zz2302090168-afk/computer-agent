import type { Category } from '../../domain/types';
import {
  applyDraft,
  changesRecommendation,
} from '../../agent/conversation-state';
import {
  categoryStringsSchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

const allowed = [
  'budget',
  'hardCap',
  'purpose',
  'mode',
  'color',
  'game',
  'brandPreferences',
  'partPreferences',
  'preferCheaper',
] as const;

export const updateRequirementsTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_requirements',
      description:
        '只更新用户明确表达的需求。指定具体型号时先查询目录，唯一匹配后将商品 ID 写入 partPreferences。',
      parameters: objectSchema({
        budget: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
        hardCap: { type: 'boolean' },
        purpose: {
          type: 'string',
          enum: ['游戏', '办公', '剪辑设计', '编程', '本地 AI'],
        },
        mode: { type: 'string', enum: ['diy', 'prebuilt', 'both'] },
        color: { type: 'string', enum: ['不限', '黑色', '白色'] },
        game: { type: 'string' },
        brandPreferences: categoryStringsSchema(),
        partPreferences: categoryStringsSchema(),
        preferCheaper: { type: 'boolean' },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, allowed);
    // applyDraft 会执行字段级校验；先在这里拒绝额外字段，防止类型断言把模型输入带入业务层。
    const patch = { ...input };
    if (
      patch.partPreferences &&
      typeof patch.partPreferences === 'object' &&
      !Array.isArray(patch.partPreferences)
    ) {
      for (const [category, id] of Object.entries(patch.partPreferences)) {
        if (typeof id !== 'string' || !id) throw Error('指定型号商品 ID 无效');
        const authorized =
          runtime.draft.selectionAuthorizations?.[category as Category];
        const part = context.catalog.parts.find(
          (item) => item.id === id && item.category === category,
        );
        const normalized = part?.name.toUpperCase().replace(/\s+/g, ' ');
        const inScope =
          !!authorized &&
          !!normalized &&
          normalized.includes(authorized.toUpperCase()) &&
          (!/^RTX 5070$/i.test(authorized) ||
            !/RTX 5070\s*TI/.test(normalized));
        if (!runtime.approvedPartIds.has(id) && !inScope)
          throw Error('指定型号尚未通过唯一目录结果或授权范围确认');
        if (inScope)
          patch.selectionSources = {
            ...(patch.selectionSources as object),
            [category]: 'assistant',
          };
        else runtime.specifiedUpdated = true;
      }
    }
    const previous = runtime.draft;
    runtime.draft = applyDraft(
      applyDraft(runtime.draft, patch),
      runtime.explicitPatch,
    );
    // 需求变化后旧方案必须立即失效，不能让右侧继续显示看似已更新的结果。
    if (changesRecommendation(previous, runtime.draft)) runtime.result = null;
    const version = await context.onUpdate?.(
      'requirements',
      runtime.draft,
      runtime.result,
    );
    runtime.toolsUsed.push('记录需求');
    return {
      draft: runtime.draft,
      recommendationExpired: runtime.result === null,
      version,
    };
  },
};
