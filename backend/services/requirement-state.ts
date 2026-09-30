import { labels } from '../domain/types';
import type { RequirementItem } from '../domain/requirement-acceptance';

export function mergeRequirementItems(
  previous: RequirementItem[] = [],
  value: unknown,
): RequirementItem[] {
  if (!Array.isArray(value) || value.length > 32)
    throw Error('需求清单必须是最多32项的数组');
  const next = new Map(previous.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw Error('需求条目无效');
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).some(
        (key) =>
          ![
            'id',
            'text',
            'sourceMessageId',
            'strength',
            'active',
            'rule',
            'category',
            'field',
            'expected',
          ].includes(key),
      )
    )
      throw Error('需求包含未知字段');
    for (const field of ['id', 'text', 'sourceMessageId', 'category', 'field'])
      if (
        typeof item[field] !== 'string' ||
        !item[field].trim() ||
        item[field].length > 400
      )
        throw Error('需求标识、原文与字段不能为空');
    if (
      typeof item.id !== 'string' ||
      item.id.startsWith('builtin:') ||
      seen.has(item.id)
    )
      throw Error('需求ID重复或保留');
    if (
      !Object.hasOwn(labels, String(item.category)) ||
      !['hard', 'soft'].includes(String(item.strength)) ||
      typeof item.active !== 'boolean' ||
      !['min', 'max', 'equals', 'not_equals', 'preserve', 'semantic'].includes(
        String(item.rule),
      )
    )
      throw Error('需求类别或检查规则无效');
    if (
      (typeof item.expected !== 'string' &&
        typeof item.expected !== 'number') ||
      (typeof item.expected === 'number' && !Number.isFinite(item.expected))
    )
      throw Error('需求期望值无效');
    if (
      ['min', 'max'].includes(String(item.rule)) &&
      (typeof item.expected !== 'number' || item.expected < 0)
    )
      throw Error('数值需求必须使用非负数');
    if (
      item.rule === 'semantic' &&
      [
        'capacity',
        'height',
        'length',
        'width',
        'depth',
        'volume',
        'type',
        'coolingType',
        'watts',
        'price',
        'id',
        'model',
        'brand',
      ].includes(String(item.field))
    )
      throw Error('可精确判断的字段不能交给语义验收');
    if (item.rule === 'preserve' && item.field !== 'id')
      throw Error('保留配件必须绑定商品ID');
    if (
      ['min', 'max', 'equals', 'not_equals'].includes(String(item.rule)) &&
      ![
        'capacity',
        'height',
        'length',
        'width',
        'depth',
        'volume',
        'type',
        'coolingType',
        'watts',
        'interface',
        'socket',
        'ddr',
        'brand',
        'model',
      ].includes(String(item.field))
    )
      throw Error('精确需求字段不受支持，不能伪装成语义判断');
    seen.add(item.id);
    next.set(item.id, {
      ...item,
      version: (next.get(item.id)?.version ?? 0) + 1,
    } as RequirementItem);
  }
  if (next.size > 64) throw Error('本次会话需求条目过多');
  return [...next.values()];
}
