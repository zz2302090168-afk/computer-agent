import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });
const before = process.argv[2] === 'before';
const selector = process.argv[2] === 'selector';
const directory = resolve(
  'reports',
  `jev-${before ? 'before' : selector ? 'selector' : 'comparison'}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(directory, { recursive: true });
const scenarios = selector
  ? ['multi', 'dependency', 'pagination', 'failure']
  : ['browse', 'multi', 'simple', 'dependency', 'pagination', 'failure'];
const repetitions = before ? 1 : 3;
const files = [
  'backend/agent/conversation.ts',
  'backend/agent/prompts.ts',
  'backend/agent/execution-plan.ts',
  'backend/tests/performance-sample.ts',
  'scripts/jev-comparison.mjs',
  ...(!before ? ['backend/agent/jev-router.ts'] : []),
  ...(selector ? ['backend/agent/jev-tool-selector.ts'] : []),
];
const hashes = () =>
  Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );
const initial = hashes();
writeFileSync(
  resolve(directory, 'manifest.json'),
  JSON.stringify(
    {
      before,
      selector,
      repetitions,
      scenarios,
      model: process.env.MODEL_NAME,
      jevModel: process.env.TYPESAFE_MODEL || 'jev-latest',
      hashes: initial,
      design: `${selector ? '仅切换JEV_TOOL_SELECTOR_ENABLED，入口Jev关闭' : '仅切换JEV_ROUTER_ENABLED，工具Jev关闭'}；独立进程；无预热；交替AB/BA；固定夹具；失败保留；等权非线上流量权重`,
    },
    null,
    2,
  ),
);
const rows = [];
for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const [index, scenario] of scenarios.entries()) {
    const variants = before
      ? ['off']
      : (repetition + index) % 2
        ? ['off', 'on']
        : ['on', 'off'];
    for (const variant of variants) {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          './scripts/register-typescript.mjs',
          'backend/tests/performance-sample.ts',
          scenario,
        ],
        {
          encoding: 'utf8',
          timeout: 90000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            JEV_ROUTER_ENABLED:
              !selector && variant === 'on' ? 'true' : 'false',
            JEV_TOOL_SELECTOR_ENABLED:
              selector && variant === 'on' ? 'true' : 'false',
            PERFORMANCE_VARIANT: variant,
          },
        },
      );
      let result;
      try {
        result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
      } catch {
        result = {
          scenario,
          variant,
          passed: false,
          failure: 'process_error',
          calls: null,
          jevCalls: null,
          elapsedMs: null,
          inputTokens: null,
          outputTokens: null,
          jevInputTokens: null,
          jevOutputTokens: null,
        };
      }
      rows.push({ ...result, repetition });
      appendFileSync(
        resolve(directory, 'samples.jsonl'),
        JSON.stringify(rows.at(-1)) + '\n',
      );
      console.log(
        `${rows.length}/${scenarios.length * repetitions * (before ? 1 : 2)} ${scenario} ${variant} ${result.passed ? 'PASS' : result.failure} ${result.elapsedMs}ms LLM=${result.calls} Jev=${result.jevCalls}`,
      );
    }
  }
}
const changed = Object.entries(hashes())
  .filter(([file, hash]) => initial[file] !== hash)
  .map(([file]) => file);
writeFileSync(
  resolve(directory, 'integrity.json'),
  JSON.stringify({ changed }, null, 2),
);
if (changed.length) throw Error('评测中源码改变，保留原始记录但不生成有效汇总');
const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const percentile = (values, q) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1] ?? null;
const summarize = (group) => {
  const tokenRows = group.filter((r) =>
    [r.inputTokens, r.outputTokens, r.jevInputTokens, r.jevOutputTokens].every(
      Number.isFinite,
    ),
  );
  const times = group.map((r) => r.elapsedMs).filter(Number.isFinite);
  return {
    n: group.length,
    passed: group.filter((r) => r.passed).length,
    selectorAccepted: group
      .flatMap((r) => r.toolSelections ?? [])
      .filter((s) => s.reason === 'selected').length,
    selectorFallback: group
      .flatMap((r) => r.toolSelections ?? [])
      .filter((s) => s.reason !== 'selected').length,
    meanLlmCalls: mean(group.map((r) => r.calls).filter(Number.isFinite)),
    meanJevCalls: mean(group.map((r) => r.jevCalls).filter(Number.isFinite)),
    tokenSamples: tokenRows.length,
    meanLlmTokens: mean(tokenRows.map((r) => r.inputTokens + r.outputTokens)),
    meanJevTokens: mean(
      tokenRows.map((r) => r.jevInputTokens + r.jevOutputTokens),
    ),
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
  };
};
const summary = Object.fromEntries(
  ['all', ...scenarios].map((s) => [
    s,
    Object.fromEntries(
      (before ? ['off'] : ['off', 'on']).map((v) => [
        v,
        summarize(
          rows.filter(
            (r) => r.variant === v && (s === 'all' || r.scenario === s),
          ),
        ),
      ]),
    ),
  ]),
);
writeFileSync(
  resolve(directory, 'summary.json'),
  JSON.stringify(summary, null, 2),
);
const lines = [
  '# Jev路由同条件对照',
  '',
  `${selector ? 'off原模型选工具并填参数，on由Jev选择工具再由原模型仅填参数；可直执行和收尾路径不加Jev；低置信度/异常回退原选择。' : 'off保留原流程，on仅启用Jev窄范围只读入口。'}耗时包括Jev及回退。LLM与Jev Token分别报告，不假设单价相同。失败计入分母；缺失usage不计零。`,
  '',
  '| 场景 | 开关 | 通过 | 平均LLM调用 | 平均Jev调用 | 完整用量样本 | 平均LLM Token | 平均Jev Token | 中位ms | P95ms |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
];
for (const [s, variants] of Object.entries(summary))
  for (const [v, r] of Object.entries(variants))
    lines.push(
      `| ${s} | ${v} | ${r.passed}/${r.n} | ${r.meanLlmCalls} | ${r.meanJevCalls} | ${r.tokenSamples} | ${r.meanLlmTokens} | ${r.meanJevTokens} | ${r.medianMs} | ${r.p95Ms} |`,
    );
lines.push(
  '',
  '小样本；nearest-rank P95；每场景3次时P95等于最大值。无人工最终文本质量评审；隔离目录无真实数据库/页面。不是线上整体收益，不以少完成任务换性能。',
);
writeFileSync(resolve(directory, 'report.md'), lines.join('\n'));
console.log(`REPORT ${directory}`);
