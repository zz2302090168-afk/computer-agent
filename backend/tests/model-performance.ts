import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { runConversation } from '../agent/conversation';
import { fixture } from './pc-fixture';

// 同一夹具、请求与模型；只打印指标，不打印认证信息或原始接口响应。
loadEnv({ path: '.env.local', quiet: true });
const config = {
  key: process.env.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME,
};
if (!config.key || !config.base || !config.model) throw Error('缺少模型配置');
const originalFetch = globalThis.fetch;
let calls = 0,
  inputCharacters = 0,
  inputTokens = 0,
  outputTokens = 0,
  usageResponses = 0;
const observations: Promise<void>[] = [];
globalThis.fetch = async (...args) => {
  calls++;
  const raw = args[1]?.body;
  if (typeof raw !== 'string') throw Error('测量请求体必须为字符串');
  const body = JSON.parse(raw);
  inputCharacters += JSON.stringify({
    messages: body.messages,
    tools: body.tools,
  }).length;
  const response = await originalFetch(...args);
  observations.push(
    response
      .clone()
      .text()
      .then((stream) => {
        let usage:
          | { prompt_tokens: number; completion_tokens: number }
          | undefined;
        for (const line of stream.split('\n')) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          try {
            const event = JSON.parse(line.slice(5));
            if (event.usage) usage = event.usage;
          } catch {
            /* 非完整数据行不作为用量证据 */
          }
        }
        if (
          usage &&
          Number.isFinite(usage.prompt_tokens) &&
          Number.isFinite(usage.completion_tokens)
        ) {
          usageResponses++;
          inputTokens += usage.prompt_tokens;
          outputTokens += usage.completion_tokens;
        }
      })
      .catch(() => {}),
  );
  return response;
};
const f = fixture(),
  started = performance.now();
try {
  const result = await runConversation(
    config,
    {
      task: f.runtime.task,
      currentTaskId: 'task',
      draft: f.runtime.draft,
      result: f.runtime.result,
      messages: [],
    },
    '分别查询显卡目录价格和CPU目录价格。这是两个独立查询，互不依赖，不修改需求或配置。',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'performance-fixture',
    f.context.onTaskChange,
    undefined,
    AbortSignal.timeout(60000),
  );
  const elapsedMs = Math.round(performance.now() - started);
  await Promise.all(observations);
  assert.equal(result.executionPlan?.nodes.length, 2);
  assert.ok(
    result.executionPlan.nodes.every((node) => node.status === 'completed'),
  );
  assert.equal(f.saved.length, 0);
  console.log(
    JSON.stringify({
      label: process.argv[2] ?? 'sample',
      calls,
      elapsedMs,
      inputCharacters,
      usageResponses,
      inputTokens: usageResponses === calls ? inputTokens : null,
      outputTokens: usageResponses === calls ? outputTokens : null,
      batches: result.executionPlan.parallelBatches,
      passed: true,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
}
