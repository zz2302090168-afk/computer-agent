import { config as loadEnv } from 'dotenv';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';

export const cases = {
  browse: '查询显卡目录价格，不修改需求或配置。',
  simple: '只查询目录中900元以内的显卡，不修改需求或配置。',
  multi:
    '分别查询显卡目录价格和CPU目录价格。这是两个独立查询，互不依赖，不修改需求或配置。',
  dependency:
    '先把主机预算记录为9000元，暂不生成配置；然后查询价格不超过新预算十分之一的显卡。',
  pagination:
    '查询所有显卡的型号和价格，每次查询最多2条，继续翻页直到查完，不修改需求或配置。',
  failure:
    '分别查询显卡和CPU的目录价格。两个独立查询，不修改需求或配置；某项查询失败时明确说明，不要影响另一项查询。',
};

if (process.argv[2] && Object.hasOwn(cases, process.argv[2])) {
  const scenario = process.argv[2] as keyof typeof cases;
  loadEnv({ path: '.env.local', quiet: true });
  const config = {
    key: process.env.MODEL_API_KEY,
    base: process.env.MODEL_BASE_URL,
    model: process.env.MODEL_NAME,
  };
  if (!config.key || !config.base || !config.model) throw Error('缺少模型配置');
  const f = fixture(),
    originalFetch = globalThis.fetch;
  const observations: Promise<void>[] = [];
  let calls = 0,
    usageResponses = 0,
    inputTokens = 0,
    outputTokens = 0,
    reads = 0;
  const coverage = new Set<string>();
  let jevCalls = 0,
    jevInputTokens = 0,
    jevOutputTokens = 0,
    jevUsageResponses = 0;
  globalThis.fetch = async (...args) => {
    if (args[0] === 'https://api.typesafe.ai/v1/systemone') {
      jevCalls++;
      const response = await originalFetch(...args);
      observations.push(
        response
          .clone()
          .json()
          .then((data) => {
            if (
              Number.isFinite(data.usage?.input_tokens) &&
              Number.isFinite(data.usage?.output_tokens)
            ) {
              jevUsageResponses++;
              jevInputTokens += data.usage.input_tokens;
              jevOutputTokens += data.usage.output_tokens;
            }
          })
          .catch(() => {}),
      );
      return response;
    }
    calls++;
    if (typeof args[1]?.body !== 'string') throw Error('请求格式无效');
    const request = JSON.parse(args[1].body);
    for (const message of request.messages ?? []) {
      if (message.role !== 'tool') continue;
      try {
        const output = JSON.parse(message.content);
        if (
          output.operation?.tool === 'search_catalog' &&
          !output.operation.failed
        )
          for (const match of output.data?.matches ?? [])
            if (match.category === 'gpu') coverage.add(match.id);
      } catch {
        /* 非JSON工具消息不作为覆盖证据 */
      }
    }
    const response = await originalFetch(...args);
    observations.push(
      response
        .clone()
        .text()
        .then((stream) => {
          let usage:
            | { prompt_tokens: number; completion_tokens: number }
            | undefined;
          for (const line of stream.split('\n'))
            if (line.startsWith('data:') && !line.includes('[DONE]')) {
              try {
                const event = JSON.parse(line.slice(5));
                if (event.usage) usage = event.usage;
              } catch {
                /* 不完整行不作为用量证据 */
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
  const started = performance.now();
  let passed = false,
    failure: string | null = null,
    checks: Record<string, boolean> = {},
    outcomes: unknown;
  let toolSelections: unknown;
  try {
    const output = await runConversation(
      config,
      {
        task: f.runtime.task,
        currentTaskId: 'task',
        draft: f.runtime.draft,
        result: f.runtime.result,
        messages: [],
      },
      cases[scenario],
      'current',
      f.catalog,
      async () => {
        if (scenario === 'failure' && reads++ === 0)
          throw Error('评测注入：首次目录读取失败');
        return f.catalog;
      },
      f.context.onUpdate!,
      'performance-suite',
      f.context.onTaskChange,
      undefined,
      AbortSignal.timeout(60000),
    );
    const facts = output.facts,
      nodes = output.executionPlan?.nodes ?? [];
    toolSelections = output.toolSelections;
    const successfulSearch = (category: string, maxPrice?: number) =>
      facts.some((fact) => {
        const args = fact.arguments as
          | { category?: string; maxPrice?: number }
          | undefined;
        return (
          fact.tool === 'search_catalog' &&
          !fact.failed &&
          args?.category === category &&
          (maxPrice === undefined || args.maxPrice === maxPrice)
        );
      });
    checks = {
      hasAnswer: !!output.messages.at(-1)?.content,
      noUnauthorizedWrites:
        scenario === 'dependency'
          ? !facts.some(
              (fact) =>
                !fact.failed &&
                [
                  'recommend_pc',
                  'replace_parts',
                  'select_plan',
                  'confirm_selections',
                ].includes(fact.tool),
            )
          : f.saved.length === 0,
      budget: output.draft.budget === (scenario === 'dependency' ? 9000 : 8000),
    };
    if (scenario === 'simple') checks.query = successfulSearch('gpu', 900);
    if (scenario === 'browse') checks.query = successfulSearch('gpu');
    if (scenario === 'multi') {
      checks.queries = successfulSearch('gpu') && successfulSearch('cpu');
      checks.tasks =
        nodes.length === 2 && nodes.every((n) => n.status === 'completed');
    }
    if (scenario === 'dependency') {
      const save = nodes.find((n) => n.action === 'save_requirements'),
        query = nodes.find((n) => n.action === 'search_catalog');
      checks.dependency = !!save && !!query?.dependsOn.includes(save.id);
      checks.query = successfulSearch('gpu', 900);
      checks.order =
        facts.findIndex(
          (fact) => fact.tool === 'update_requirements' && !fact.failed,
        ) <
        facts.findIndex(
          (fact) => fact.tool === 'search_catalog' && !fact.failed,
        );
    }
    if (scenario === 'pagination') {
      checks.coverage = f.catalog.parts
        .filter((part) => part.category === 'gpu')
        .every((part) => coverage.has(part.id));
      checks.pageLimit = facts
        .filter((fact) => fact.tool === 'search_catalog' && !fact.failed)
        .every((fact) => {
          const limit = (fact.arguments as { limit?: number })?.limit;
          return typeof limit === 'number' && limit <= 2;
        });
    }
    if (scenario === 'failure') {
      checks.injected = facts.some(
        (fact) =>
          fact.tool === 'search_catalog' &&
          fact.failed &&
          fact.error?.includes('评测注入'),
      );
      checks.independentContinued =
        successfulSearch('gpu') || successfulSearch('cpu');
      checks.tasks =
        nodes.length === 2 &&
        nodes.every((node) =>
          node.status === 'completed'
            ? facts.some(
                (fact) =>
                  fact.nodeId === node.id &&
                  fact.tool === 'search_catalog' &&
                  !fact.failed,
              )
            : node.status === 'blocked' && !!node.reply,
        );
    } else
      checks.completed =
        nodes.length > 0 && nodes.every((node) => node.status === 'completed');
    passed = Object.values(checks).every(Boolean);
    if (!passed) failure = 'assertion_failed';
    outcomes = nodes.map(
      ({
        id,
        action,
        dependsOn,
        status,
        outcome,
        catalogScope,
        catalogProgress,
      }) => ({
        id,
        action,
        dependsOn,
        status,
        outcome,
        catalogScope,
        catalogProgress,
      }),
    );
  } catch (error) {
    failure =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : 'run_error';
  }
  const elapsedMs = Math.round(performance.now() - started);
  await Promise.all(observations);
  globalThis.fetch = originalFetch;
  console.log(
    JSON.stringify({
      scenario,
      variant: process.env.PERFORMANCE_VARIANT,
      passed,
      failure,
      checks,
      outcomes,
      toolSelections,
      calls,
      jevCalls,
      jevInputTokens: jevUsageResponses === jevCalls ? jevInputTokens : null,
      jevOutputTokens: jevUsageResponses === jevCalls ? jevOutputTokens : null,
      elapsedMs,
      usageResponses,
      inputTokens: usageResponses === calls && calls > 0 ? inputTokens : null,
      outputTokens: usageResponses === calls && calls > 0 ? outputTokens : null,
    }),
  );
}
