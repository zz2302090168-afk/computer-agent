import type { RecommendationResult } from '@/backend/domain/types';
import { readResponse } from './api';
type Context = {
  registerTool: (
    tool: unknown,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function registerConfigurationTool(
  onResult: (data: RecommendationResult) => void,
) {
  const context = (document as Document & { modelContext?: Context })
    .modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  void Promise.resolve(
    context.registerTool(
      {
        name: 'generate_pc_configuration',
        title: '生成主机配置',
        description:
          '按预算和用途生成主机方案并更新当前页面。会保存当前会话的方案。',
        inputSchema: {
          type: 'object',
          properties: {
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 },
            purpose: {
              type: 'string',
              enum: ['游戏', '办公', '剪辑设计', '编程', '本地 AI'],
            },
            mode: { type: 'string', enum: ['diy', 'prebuilt', 'both'] },
            color: { type: 'string', enum: ['不限', '黑色', '白色'] },
          },
          required: ['budget', 'purpose'],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        async execute(input: unknown) {
          if (!input || typeof input !== 'object')
            throw Error('需要预算与用途');
          const r = await fetch('/api/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          });
          const data = await readResponse<RecommendationResult>(r);
          onResult(data);
          return {
            summary: data.summary,
            plans: data.plans.map((p) => ({
              id: p.id,
              total: p.total,
              name: p.name,
            })),
          };
        },
      },
      { signal: lifecycle.signal },
    ),
  ).catch(() => {});
  return () => lifecycle.abort();
}
