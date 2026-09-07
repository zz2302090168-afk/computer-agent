import type { Category, Requirements } from '../domain/types';
import { budgetRange } from '../rules/budget';

export type Draft = Partial<Requirements>;
const recommendationFields: (keyof Requirements)[] = [
  'budget',
  'hardCap',
  'purpose',
  'mode',
  'color',
  'game',
  'brandPreferences',
  'partPreferences',
  'seriesPreferences',
  'selectionAuthorizations',
  'preferCheaper',
];

export function applyDraft(
  draft: Draft,
  patch: Record<string, unknown>,
): Draft {
  const next = { ...draft };
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
  }
  for (const [key, allowed] of Object.entries({
    purpose: ['游戏', '办公', '剪辑设计', '编程', '本地 AI'],
    mode: ['diy', 'prebuilt', 'both'],
    color: ['不限', '黑色', '白色'],
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
  for (const field of ['seriesPreferences', 'selectionAuthorizations'] as const)
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
  return next;
}

export function changesRecommendation(before: Draft, after: Draft) {
  // 只要影响选型的事实改变，持久化层就应清空旧方案并等待重新校验。
  return recommendationFields.some(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export function completeRequirements(draft: Draft): Requirements {
  if (!draft.budget || !draft.purpose)
    throw Error('还需要主机预算和主要用途，请先询问用户。');
  return {
    budget: draft.budget,
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
    selectionAuthorizations: draft.selectionAuthorizations ?? {},
    selectionSources: draft.selectionSources ?? {},
    partSelections: draft.partSelections ?? {},
    preferCheaper: draft.preferCheaper ?? false,
  };
}

export function inferExplicitPatch(message: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const budget = message.match(
    /(?:^|预算(?:改成|调整为|是|到)?|最多|不超过|上限(?:是|为)?|控制在)\s*(\d+(?:\.\d+)?)\s*(万|千|k)?/i,
  );
  if (budget) {
    patch.budget =
      Number(budget[1]) *
      (budget[2] === '万' ? 10000 : /千|k/i.test(budget[2] ?? '') ? 1000 : 1);
    patch.hardCap = /(?:最多|不超过|上限|不能超|不要超|以内)/.test(message);
  }
  if (/白色/.test(message)) patch.color = '白色';
  else if (/黑色/.test(message)) patch.color = '黑色';
  else if (/颜色不限|不限颜色/.test(message)) patch.color = '不限';
  if (/(?:只看|改成|选择|要)?\s*(?:已组装)?整机/.test(message))
    patch.mode = 'prebuilt';
  if (/DIY|自己装|自由搭配/i.test(message)) patch.mode = 'diy';
  if (/两种都|都看看|都可以/.test(message)) patch.mode = 'both';
  if (/便宜(?:一点|些)|省钱|更低价/.test(message)) patch.preferCheaper = true;
  if (/办公|文档/.test(message)) patch.purpose = '办公';
  else if (/游戏/.test(message)) patch.purpose = '游戏';
  else if (/剪辑|设计/.test(message)) patch.purpose = '剪辑设计';
  else if (/编程|开发/.test(message)) patch.purpose = '编程';
  else if (/本地\s*AI|大模型|显存/i.test(message)) patch.purpose = '本地 AI';
  const gpuSeries = message.match(/(?:RTX\s*)?(5070|5060|5080|5090)(?!\s*Ti)/i);
  if (gpuSeries) {
    const series = `RTX ${gpuSeries[1]}`;
    patch.seriesPreferences = { gpu: series };
    if (/你选|你自己选|随便|都可以/.test(message))
      patch.selectionAuthorizations = { gpu: series };
  }
  if (/(?:其他|其余).*(?:你选|随便|都可以)/.test(message))
    patch.selectionAuthorizations = Object.fromEntries(
      [
        'cpu',
        'gpu',
        'memory',
        'motherboard',
        'psu',
        'case',
        'storage',
        'cooler',
      ].map((category) => [category, '现有需求范围内']),
    );
  if (/颜色随便|颜色都可以|颜色不限/.test(message)) patch.color = '不限';
  return patch;
}
