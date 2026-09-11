import { applyDraft } from '../../agent/conversation-state';
import { colorCategories } from '../../rules/color';
import {
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
  'preferCheaper',
  'preferExpensive',
] as const;

export const requirementPatchProperties = {
  budgetTolerance: {
    type: 'number',
    minimum: 0,
    description:
      '用户明确允许的总价绝对误差，例如误差不超过50元填50；不得擅自设置',
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
  hardCap: { type: 'boolean' },
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
  brandPreferences: categoryStringsSchema(),
  partPreferences: categoryStringsSchema(),
  seriesPreferences: categoryStringsSchema(),
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
