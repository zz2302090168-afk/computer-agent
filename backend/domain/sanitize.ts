import type { RecommendationResult } from './types';

/**
 * 历史 JSON 可能包含已撤下的 fps 字段。读取和写回时递归剔除它，
 * 既保留任务其余数据，也确保接口与导出不会重新暴露旧功能字段。
 */
export function stripLegacyFps<T>(value: T): T {
  if (Array.isArray(value))
    return value.map((item) => stripLegacyFps(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'fps')
      .map(([key, item]) => [key, stripLegacyFps(item)]),
  ) as T;
}

export function sanitizeRecommendationResult(
  value: unknown,
): RecommendationResult {
  return stripLegacyFps(value) as RecommendationResult;
}
