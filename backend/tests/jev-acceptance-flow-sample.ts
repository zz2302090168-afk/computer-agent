import { config } from 'dotenv';
import { fixture } from './pc-fixture';
import { addSyntheticThermalEvidence } from './thermal-fixture';
import { runConversation } from '../agent/conversation';
import { completeRequirements } from '../agent/conversation-state';

config({ path: '.env.local', quiet: true });
// 排除之前的路由/工具选择实验，只改变这次新增的需求验收。
process.env.JEV_ROUTER_ENABLED = 'false';
process.env.JEV_TOOL_SELECTOR_ENABLED = 'false';
const model = {
  key: process.env.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME,
};
if (!model.key || !model.base || !model.model || !process.env.TYPESAFE_API_KEY)
  throw Error('缺少测试配置');
const confirmed = process.argv[2] === 'confirmed';
const semantic = process.argv[2] !== 'rules';
const f = fixture();
for (const part of f.catalog.parts.filter((part) => part.category === 'case'))
  part.specs.appearance = '纯黑封闭面板，无灯带、无RGB灯扇，无装饰灯光';
addSyntheticThermalEvidence(f.catalog.parts);
const text = `请按已记录需求，现在生成一套8000元游戏DIY主机，预算误差50元，黑色，选择满足条件中最便宜的一套。${semantic ? '机箱外观要简洁，不要明显灯光装饰。' : ''}不需要显示器，不确认购买。`;
const draft = completeRequirements({
  ...f.runtime.draft,
  preferCheaper: true,
  requirementItems: semantic
    ? [
        {
          id: 'appearance',
          text: '机箱外观要简洁，不要明显灯光装饰',
          sourceMessageId: confirmed ? 'previous' : 'current',
          strength: 'hard',
          active: true,
          version: 1,
          rule: 'semantic',
          category: 'case',
          field: 'appearance',
          expected: '外观简洁且无明显灯光装饰',
        },
      ]
    : [],
});
const originalFetch = globalThis.fetch;
let llmCalls = 0,
  jevCalls = 0,
  jevElapsedMs = 0;
let lastToolOutputs: unknown[] = [];
const network: { service: string; elapsedMs: number; status: number | null }[] =
  [];
globalThis.fetch = async (...args) => {
  const jev = args[0] === 'https://api.typesafe.ai/v1/systemone';
  if (jev) jevCalls++;
  else llmCalls++;
  if (!jev && typeof args[1]?.body === 'string') {
    const body = JSON.parse(args[1].body);
    lastToolOutputs = (body.messages ?? [])
      .filter((entry: { role?: string }) => entry.role === 'tool')
      .slice(-3);
  }
  const start = performance.now();
  try {
    const response = await originalFetch(...args);
    if (jev) {
      // 计入完整响应体，返回原始内容；不记录密钥/请求头/原始响应。
      const body = await response.arrayBuffer();
      const elapsedMs = Math.round(performance.now() - start);
      jevElapsedMs += elapsedMs;
      network.push({ service: 'jev', elapsedMs, status: response.status });
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - start);
    if (jev) jevElapsedMs += elapsedMs;
    network.push({ service: jev ? 'jev' : 'llm', elapsedMs, status: null });
    throw error;
  }
};
const start = performance.now();
let passed = false,
  failure: string | undefined;
let planIds: string[][] = [],
  facts: unknown,
  reply: string | undefined;
try {
  const output = await runConversation(
    model,
    {
      task: { ...f.runtime.task, draft, result: null },
      currentTaskId: 'task',
      draft,
      result: null,
      messages: confirmed
        ? [
            { id: 'previous', role: 'user', content: text, taskId: 'task' },
            {
              id: 'acknowledged',
              role: 'assistant',
              content:
                '需求已记录：8000元游戏DIY主机，误差50元，黑色，选满足约束的最低价方案；机箱外观简洁且无明显灯光装饰。尚未生成配置。',
              taskId: 'task',
            },
          ]
        : [],
    },
    confirmed ? '现在按已记录的需求生成一套配置。' : text,
    'current',
    f.catalog,
    async () => f.catalog,
    f.context.onUpdate!,
    'synthetic-jev-on-off',
    f.context.onTaskChange,
    undefined,
    AbortSignal.timeout(60000),
  );
  const plans = output.result?.plans ?? [];
  planIds = plans.map((plan) => plan.parts.map((part) => part.id).sort());
  reply = output.messages.at(-1)?.content;
  facts = output.facts.map((fact) => ({
    tool: fact.tool,
    failed: fact.failed,
    error: fact.error,
  }));
  passed =
    plans.length === 1 &&
    plans.every(
      (plan) =>
        plan.validation.status === 'pass' &&
        plan.deliveryAudit?.status === 'passed' &&
        plan.parts.length === 8 &&
        Math.abs(plan.total - 8000) <= 50,
    ) &&
    !!reply &&
    (process.env.JEV_AB_VARIANT === 'off'
      ? jevCalls === 0
      : !semantic || jevCalls > 0);
  if (!passed) failure = 'outcome_check_failed';
} catch (error) {
  failure = error instanceof Error ? error.message : 'run_error';
  for (const secret of [model.key, process.env.TYPESAFE_API_KEY])
    if (secret) failure = failure.replaceAll(secret, '[redacted]');
}
const elapsedMs = Math.round(performance.now() - start);
globalThis.fetch = originalFetch;
console.log(
  JSON.stringify({
    passed,
    failure,
    elapsedMs,
    llmCalls,
    jevCalls,
    jevElapsedMs,
    planIds,
    facts,
    reply,
    network,
    lastToolOutputs,
  }),
);
