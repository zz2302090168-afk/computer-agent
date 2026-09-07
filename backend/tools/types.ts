import type { Draft } from '../agent/conversation-state';
import type { ToolDefinition } from '../agent/chat-model';
import type { Catalog, RecommendationResult } from '../domain/types';

export const categories = [
  'cpu',
  'gpu',
  'memory',
  'motherboard',
  'psu',
  'case',
  'storage',
  'cooler',
] as const;
export const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required, additionalProperties: false });
export const categorySchema = { type: 'string', enum: categories };
export const categoryStringsSchema = () =>
  objectSchema(
    Object.fromEntries(
      categories.map((category) => [category, { type: 'string' }]),
    ),
  );

export type ToolRuntime = {
  draft: Draft;
  result: RecommendationResult | null;
  explicitPatch: Record<string, unknown>;
  approvedPartIds: Set<string>;
  attemptedPlanTool: boolean;
  successfulPlanTool: '' | 'recommend' | 'assemble';
  ambiguousSearch: boolean;
  emptySearch: boolean;
  specifiedUpdated: boolean;
  toolsUsed: string[];
  toolErrors: string[];
};

export type ToolContext = {
  sessionId?: string;
  taskId?: string;
  catalog: Catalog;
  reloadCatalog: () => Promise<Catalog>;
  onUpdate?: (
    type: 'requirements' | 'parts' | 'plan',
    draft: Draft,
    result: RecommendationResult | null,
  ) => Promise<number>;
};

export type RegisteredTool = {
  definition: ToolDefinition;
  execute: (
    argumentsValue: unknown,
    context: ToolContext,
    runtime: ToolRuntime,
  ) => Promise<unknown>;
};

// JSON Schema 只帮助模型生成参数；这里的检查才是服务端信任边界。
export function parseObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('工具参数必须是对象');
  return value as Record<string, unknown>;
}

export function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw Error(`工具参数包含未知字段：${unknown}`);
}
