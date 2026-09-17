import { BUDGET_TOLERANCE, MAX_BUDGET_TOLERANCE } from '../../rules/budget';
import { applyDraft } from '../../agent/conversation-state';
import { colorCategories } from '../../rules/color';
import {
  categories,
  categoryStringsSchema,
  objectSchema,
  parseObject,
  rejectUnknownKeys,
} from '../types';

export const requirementPatchKeys = [
  'budget',
  'budgetTolerance',
  'partColors',
  'hardCap',
  'purpose',
  'mode',
  'color',
  'game',
  'brandPreferences',
  'partPreferences',
  'seriesPreferences',
  'excludedModels',
  'excludedBrands',
  'excludedColors',
  'preferCheaper',
  'preferExpensive',
] as const;

export const requirementPatchProperties = {
  budgetTolerance: {
    type: 'number',
    minimum: 0,
    maximum: MAX_BUDGET_TOLERANCE,
    description: `默认误差为${BUDGET_TOLERANCE}元。此字段是预算上下偏差，不是超支许可。用户只说“不超过预算”“预算以内”“不能加钱”时，设置hardCap=true并省略budgetTolerance，不能填0；这允许比预算便宜。只有明确要求“误差为0”“必须恰好等于预算”才填0，并按零误差流程提示和确认。明确指定误差不超过50元填50；同时不许超预算则另设hardCap=true。不得擅自放宽误差。`,
  },
  partColors: {
    ...objectSchema(
      Object.fromEntries(
        colorCategories.map((category) => [category, { type: 'string' }]),
      ),
    ),
    description:
      '仅显卡、内存、主板、电源、机箱、散热参与配色；CPU和硬盘没有配色约束。指定单件颜色时填写对应类别，如白色机箱、黑色散热填case=白色,cooler=黑色。空字符串删除该类别覆盖。',
  },
  budget: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
  hardCap: {
    type: 'boolean',
    description:
      '用户明确要求总价不能超过预算时为true，只收紧价格上界，不表示必须花满预算，也不表示budgetTolerance=0。例如预算6000元、绝对不超过6000元：budget=6000、hardCap=true，未指定误差时省略budgetTolerance，预算用途齐全即继续推荐。',
  },
  purpose: {
    type: 'string',
    enum: ['游戏', '办公', '剪辑设计', '编程', '本地 AI'],
  },
  mode: { type: 'string', enum: ['diy', 'prebuilt', 'both'] },
  color: {
    type: 'string',
    enum: ['不限', '黑色', '白色', '黑色优先，白色备选'],
  },
  game: { type: 'string' },
  brandPreferences: {
    ...categoryStringsSchema(),
    description:
      '按类别填写品牌；CPU的AMD、Intel、英特尔属于品牌，不能写入seriesPreferences。',
  },
  partPreferences: categoryStringsSchema(),
  seriesPreferences: {
    ...categoryStringsSchema(),
    description:
      '具体产品系列或型号，例如CPU的Ryzen 7、7800X3D，显卡的RTX 5070。AMD、Intel等品牌填brandPreferences；不填写“不要AMD”等否定需求。空字符串清除该类别的旧型号条件。',
  },
  excludedModels: {
    ...objectSchema(
      Object.fromEntries(
        categories.map((category) => [
          category,
          { type: 'array', items: { type: 'string' } },
        ]),
      ),
    ),
    description:
      '用户不要的型号或系列，如不要5600X填cpu:["5600X"]；不能写入必须匹配的seriesPreferences。每类数组替换该类排除条件，空数组清除，未提交类别保留。',
  },
  excludedBrands: {
    ...objectSchema(
      Object.fromEntries(
        categories.map((category) => [
          category,
          { type: 'array', items: { type: 'string' } },
        ]),
      ),
    ),
    description:
      '用户不要的品牌，如CPU不要AMD填cpu:["AMD"]。每类数组替换该类排除条件，空数组清除，未提交类别保留。',
  },
  excludedColors: {
    type: 'array',
    items: { type: 'string' },
    description:
      '整套六类外观配件禁止的颜色。如不要白色填["白色"]，color填不限；绝不能理解成白色备选。数组替换旧排除颜色，空数组清除。',
  },
  preferCheaper: { type: 'boolean' },
  preferExpensive: {
    type: 'boolean',
    description:
      '用户明确要求最贵时启用，在预算和兼容约束内最大化总价，不表示性能最强',
  },
};

export function validateRequirementPatch(value: unknown) {
  const input = parseObject(value);
  rejectUnknownKeys(input, requirementPatchKeys);
  // applyDraft 是字段级运行时校验器；传入空状态可验证类型和值域而不产生副作用。
  applyDraft({}, input);
  return input;
}
