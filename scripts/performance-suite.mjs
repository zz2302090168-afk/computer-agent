import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local', quiet: true });

const directory = resolve(
  'reports',
  `performance-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
mkdirSync(directory, { recursive: true });
const scenarios = ['simple', 'multi', 'dependency', 'pagination', 'failure'];
const repetitions = 5;
const files = [
  ...readdirSync('backend', {
    recursive: true,
    encoding: 'utf8',
    withFileTypes: false,
  })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `backend/${name}`),
  'scripts/performance-baseline.mjs',
  'scripts/performance-suite.mjs',
];
const fingerprint = () =>
  Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256').update(readFileSync(file)).digest('hex'),
    ]),
  );
const hashes = fingerprint();
writeFileSync(
  resolve(directory, 'manifest.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      repetitions,
      scenarios,
      model: process.env.MODEL_NAME,
      node: process.version,
      design:
        '同一当前代码关闭/开启上轮优化的消融对照；AB/BA交替；每次新进程、新会话、固定夹具；无预热；非历史版本对照',
      hashes,
    },
    null,
    2,
  ),
);
const results = [];
for (let repetition = 0; repetition < repetitions; repetition++) {
  for (const [index, scenario] of scenarios.entries()) {
    const variants =
      (repetition + index) % 2
        ? ['optimized', 'baseline']
        : ['baseline', 'optimized'];
    for (const variant of variants) {
      const child = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--import',
          './scripts/register-typescript.mjs',
          '--import',
          './scripts/performance-baseline.mjs',
          'backend/tests/performance-sample.ts',
          scenario,
        ],
        {
          env: { ...process.env, PERFORMANCE_VARIANT: variant },
          encoding: 'utf8',
          timeout: 90000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
      );
      const line = child.stdout?.trim().split(/\r?\n/).at(-1);
      let result;
      try {
        result = JSON.parse(line);
      } catch {
        result = {
          scenario,
          variant,
          passed: false,
          failure: 'process_error',
          calls: null,
          elapsedMs: null,
          inputTokens: null,
          outputTokens: null,
        };
      }
      result.repetition = repetition + 1;
      results.push(result);
      appendFileSync(
        resolve(directory, 'samples.jsonl'),
        JSON.stringify(result) + '\n',
      );
      console.log(
        `${results.length}/50 ${scenario} ${variant} ${result.passed ? 'PASS' : result.failure} ${result.elapsedMs}ms`,
      );
    }
  }
}
const changedFiles = Object.entries(fingerprint())
  .filter(([file, hash]) => hashes[file] !== hash)
  .map(([file]) => file);
writeFileSync(
  resolve(directory, 'integrity.json'),
  JSON.stringify(
    { unchanged: changedFiles.length === 0, changedFiles },
    null,
    2,
  ),
);
if (changedFiles.length)
  throw Error('评测期间代码变化，原始样本已保留但不生成有效对照报告');
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? null;
};
const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const summarize = (rows) => {
  const latencies = rows
    .filter((r) => r.elapsedMs !== null)
    .map((r) => r.elapsedMs);
  const tokens = rows
    .filter((r) => r.inputTokens !== null && r.outputTokens !== null)
    .map((r) => r.inputTokens + r.outputTokens);
  return {
    n: rows.length,
    success: rows.filter((r) => r.passed).length,
    usageComplete: tokens.length,
    meanCalls: mean(rows.filter((r) => r.calls !== null).map((r) => r.calls)),
    meanTotalTokens: mean(tokens),
    medianMs: quantile(latencies, 0.5),
    p95Ms: quantile(latencies, 0.95),
  };
};
const summary = Object.fromEntries(
  ['all', ...scenarios].map((scenario) => [
    scenario,
    Object.fromEntries(
      ['baseline', 'optimized'].map((variant) => [
        variant,
        summarize(
          results.filter(
            (r) =>
              r.variant === variant &&
              (scenario === 'all' || r.scenario === scenario),
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
  '# Agent性能消融对照报告',
  '',
  '当前代码关闭/开启查询快速完成与上下文去重；不是历史版本或生产负载测试。每组每场景5次，AB/BA交替，无预热。耗时包括失败；Token仅统计usage完整样本。成功率为程序业务断言，不代表自然语言质量已人工评审。',
  '',
  '| 场景 | 组别 | 成功/样本 | usage完整 | 平均调用 | 平均总Token | 中位耗时ms | P95耗时ms |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
];
for (const [scenario, groups] of Object.entries(summary))
  for (const [variant, s] of Object.entries(groups))
    lines.push(
      `| ${scenario} | ${variant} | ${s.success}/${s.n} | ${s.usageComplete} | ${s.meanCalls?.toFixed(2)} | ${s.meanTotalTokens?.toFixed(1)} | ${s.medianMs} | ${s.p95Ms} |`,
    );
lines.push(
  '',
  '每场景只有5个样本，nearest-rank P95等于该组最大值；全组25次的P95也不宜作为稳定线上SLA。不同请求长度、输出、网络、服务端缓存均可能影响耗时。失败不得从成功率分母中剔除；若成功率下降，不应仅以Token下降称优化有效。首次目录失败为测试夹具故障注入，不是生产故障。未测试真实数据库或页面。',
  '',
  '复现：node scripts/performance-suite.mjs。原始记录见samples.jsonl，代码指纹和方法见manifest.json。',
);
writeFileSync(resolve(directory, 'report.md'), lines.join('\n'));
console.log(`REPORT ${directory}`);
