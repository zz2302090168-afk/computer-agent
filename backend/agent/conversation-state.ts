import type { Category, Requirements, TaskDraft } from '../domain/types';
import { budgetRange, validateTolerance } from '../rules/budget';
import { isColorCategory } from '../rules/color';

export type Draft = TaskDraft;
const recommendationFields: (keyof Requirements)[] = [
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
  'selectionAuthorizations',
  'selectionAuthorizationMessageIds',
  'preferCheaper',
  'preferExpensive',
];

export function applyDraft(
  draft: Draft,
  patch: Record<string, unknown>,
): Draft {
  // 重新声明整套配色时清除旧的单件例外；同次提交的partColors可明确设定新例外。
  const next = { ...draft, ...('color' in patch ? { partColors: {} } : {}) };
  if ('budgetTolerance' in patch)
    next.budgetTolerance = validateTolerance(patch.budgetTolerance);
  if ('partColors' in patch) {
    const colors = patch.partColors;
    if (!colors || typeof colors !== 'object' || Array.isArray(colors))
      throw Error('配件颜色无效');
    next.partColors = { ...next.partColors };
    for (const [category, color] of Object.entries(colors)) {
      if (
        !isColorCategory(category) ||
        typeof color !== 'string' ||
        !['', '不限', '黑色', '白色', '黑色优先，白色备选'].includes(color)
      )
        throw Error('配件颜色类别或颜色无效');
      if (color) next.partColors[category as Category] = color;
      else delete next.partColors[category as Category];
    }
  }
  const exclusions = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.some(
        (item) => typeof item !== 'string' || !item.trim() || item.length > 100,
      )
    )
      throw Error('排除条件必须是非空名称数组');
    return [...new Set(value.map((item: string) => item.trim()))];
  };
  if ('excludedColors' in patch)
    next.excludedColors = exclusions(patch.excludedColors);
  for (const field of ['excludedModels', 'excludedBrands'] as const) {
    if (!(field in patch)) continue;
    const values = patch[field];
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw Error('排除条件类别无效');
    next[field] = { ...next[field] };
    for (const [category, value] of Object.entries(values)) {
      if (
        ![
          'cpu',
          'gpu',
          'memory',
          'motherboard',
          'psu',
          'case',
          'storage',
          'cooler',
        ].includes(category)
      )
        throw Error('排除条件类别无效');
      next[field]![category as Category] = exclusions(value);
    }
  }
  if ('budget' in patch) {
    if (typeof patch.budget !== 'number') throw Error('预算必须是数字');
    budgetRange(patch.budget);
    next.budget = patch.budget;
  }
  if ('hardCap' in patch) {
    if (typeof patch.hardCap !== 'boolean') throw Error('预算上限字段无效');
    next.hardCap = patch.hardCap;
  }
  if ('preferCheaper' in patch) {
    if (typeof patch.preferCheaper !== 'boolean') throw Error('排序偏好无效');
    next.preferCheaper = patch.preferCheaper;
    if (patch.preferCheaper) next.preferExpensive = false;
  }
  if ('preferExpensive' in patch) {
    if (typeof patch.preferExpensive !== 'boolean') throw Error('排序偏好无效');
    if (patch.preferExpensive && patch.preferCheaper)
      throw Error('最贵与最便宜不能同时选择');
    next.preferExpensive = patch.preferExpensive;
    if (patch.preferExpensive) next.preferCheaper = false;
  }
  for (const [key, allowed] of Object.entries({
    purpose: ['游戏', '办公', '剪辑设计', '编程', '本地 AI'],
    mode: ['diy', 'prebuilt', 'both'],
    color: ['不限', '黑色', '白色', '黑色优先，白色备选'],
  })) {
    if (key in patch) {
      const v = patch[key];
      if (typeof v !== 'string' || !allowed.includes(v))
        throw Error(`${key} 无效`);
      Object.assign(next, { [key]: v });
    }
  }
  if ('game' in patch) {
    if (typeof patch.game !== 'string') throw Error('游戏名称无效');
    next.game = patch.game.slice(0, 120);
  }
  if ('brandPreferences' in patch) {
    const prefs = patch.brandPreferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
      throw Error('品牌偏好无效');
    next.brandPreferences = { ...next.brandPreferences };
    for (const [key, value] of Object.entries(prefs)) {
      if (
        ![
          'cpu',
          'gpu',
          'memory',
          'motherboard',
          'psu',
          'case',
          'storage',
          'cooler',
        ].includes(key) ||
        typeof value !== 'string'
      )
        throw Error('品牌类别无效');
      if (value) next.brandPreferences[key as Category] = value.slice(0, 40);
      else delete next.brandPreferences[key as Category];
    }
  }
  if ('partPreferences' in patch) {
    const prefs = patch.partPreferences;
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
      throw Error('指定型号无效');
    next.partPreferences = { ...next.partPreferences };
    for (const [key, value] of Object.entries(prefs)) {
      if (
        ![
          'cpu',
          'gpu',
          'memory',
          'motherboard',
          'psu',
          'case',
          'storage',
          'cooler',
        ].includes(key) ||
        typeof value !== 'string'
      )
        throw Error('指定型号类别无效');
      if (value) next.partPreferences[key as Category] = value.slice(0, 100);
      else delete next.partPreferences[key as Category];
    }
  }
  // 系列限制和选择授权分开保存：授权仅对指定类别和系列有效，不能把一次“随便”扩大成永久全权。
  for (const field of [
    'seriesPreferences',
    'selectionAuthorizations',
    'selectionAuthorizationMessageIds',
    'selectionConfirmationMessageIds',
  ] as const)
    if (field in patch) {
      const prefs = patch[field];
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs))
        throw Error('系列或授权范围无效');
      next[field] = { ...next[field] };
      for (const [key, value] of Object.entries(prefs)) {
        if (
          ![
            'cpu',
            'gpu',
            'memory',
            'motherboard',
            'psu',
            'case',
            'storage',
            'cooler',
          ].includes(key) ||
          typeof value !== 'string'
        )
          throw Error('系列或授权类别无效');
        if (value) next[field]![key as Category] = value.slice(0, 100);
        else delete next[field]![key as Category];
      }
    }
  if ('selectionSources' in patch) {
    const values = patch.selectionSources;
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw Error('选择来源无效');
    next.selectionSources = { ...next.selectionSources };
    for (const [key, value] of Object.entries(values)) {
      if (
        ![
          'cpu',
          'gpu',
          'memory',
          'motherboard',
          'psu',
          'case',
          'storage',
          'cooler',
        ].includes(key) ||
        !['user', 'assistant', 'confirmed'].includes(String(value))
      )
        throw Error('选择来源无效');
      next.selectionSources[key as Category] = value as
        | 'user'
        | 'assistant'
        | 'confirmed';
    }
  }
  if ('partSelections' in patch) {
    const values = patch.partSelections;
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw Error('配件选择无效');
    next.partSelections = { ...next.partSelections };
    for (const [key, value] of Object.entries(values)) {
      if (
        ![
          'cpu',
          'gpu',
          'memory',
          'motherboard',
          'psu',
          'case',
          'storage',
          'cooler',
        ].includes(key) ||
        typeof value !== 'string'
      )
        throw Error('配件选择无效');
      next.partSelections[key as Category] = value;
    }
  }
  if (
    next.budget !== draft.budget ||
    next.budgetTolerance !== draft.budgetTolerance
  ) {
    delete next.zeroBudgetPromptMessageId;
    delete next.zeroBudgetConfirmed;
  }
  return next;
}

export function changesRecommendation(before: Draft, after: Draft) {
  // 只要影响选型的事实改变，临时状态就应清空旧方案并等待重新校验。
  return recommendationFields.some(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export function completeRequirements(draft: Draft): Requirements {
  if (draft.budgetTolerance === 0 && !draft.zeroBudgetConfirmed)
    throw Error('零误差可能找不到匹配配置，请先询问用户是否坚持并等待确认');
  if (!draft.budget || !draft.purpose)
    throw Error('还需要主机预算和主要用途，请先询问用户。');
  return {
    budget: draft.budget,
    budgetTolerance:
      draft.budgetTolerance === undefined
        ? undefined
        : validateTolerance(draft.budgetTolerance),
    partColors: draft.partColors ?? {},
    purpose: draft.purpose,
    hardCap: draft.hardCap ?? false,
    mode: draft.mode ?? 'both',
    color: draft.color ?? '不限',
    message: '',
    brand: '',
    game: draft.game ?? '',
    brandPreferences: draft.brandPreferences ?? {},
    partPreferences: draft.partPreferences ?? {},
    seriesPreferences: draft.seriesPreferences ?? {},
    excludedModels: draft.excludedModels ?? {},
    excludedBrands: draft.excludedBrands ?? {},
    excludedColors: draft.excludedColors ?? [],
    selectionAuthorizations: draft.selectionAuthorizations ?? {},
    selectionAuthorizationMessageIds:
      draft.selectionAuthorizationMessageIds ?? {},
    selectionSources: draft.selectionSources ?? {},
    selectionConfirmationMessageIds:
      draft.selectionConfirmationMessageIds ?? {},
    partSelections: draft.partSelections ?? {},
    preferCheaper: draft.preferCheaper ?? false,
    preferExpensive: draft.preferExpensive ?? false,
  };
}
