import { config } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { judgeRequirements } from '../agent/jev-requirements';
import { acceptRequirements } from '../services/requirement-acceptance';
import { completeRequirements } from '../agent/conversation-state';
import { fixture } from './pc-fixture';
import type {
  RequirementCheck,
  RequirementItem,
} from '../domain/requirement-acceptance';

// 仅合成资料；不记录请求头、凭据或原始响应，不修改生产行为。
config({ path: '.env.local', quiet: true });
if (!process.env.TYPESAFE_API_KEY) throw Error('缺少Jev测试凭据，未执行');
const cases = [
  ['机箱外观简洁，不要明显灯光装饰', '纯黑封闭面板，无灯带、无RGB灯扇', 'pass'],
  ['机箱外观简洁，不要明显灯光装饰', '正面三条RGB灯带，四把发光风扇', 'fail'],
  ['机箱外观简洁，不要明显灯光装饰', '只有型号，没有外观说明或图片', 'unknown'],
  [
    '机箱不要花哨，但可以有一个普通电源指示灯',
    '无装饰灯光，只有单个普通电源指示灯，纯色面板',
    'pass',
  ],
  ['不要明显的游戏风格装饰', '红黑撞色、尖锐线条、巨大电竞龙形标志', 'fail'],
] as const;
const checks: RequirementCheck[] = cases.map(([text, actual], i) => ({
  requirementId: `synthetic-${i}`,
  text,
  expected: text,
  actual,
  strength: 'hard',
  status: 'unknown',
  evidence: [{ source: 'synthetic', description: actual }],
  missingInformation: [],
}));
let calls = 0,
  requestBytes = 0,
  httpErrors = 0;
const request: typeof fetch = async (url, options) => {
  calls++;
  if (typeof options?.body === 'string')
    requestBytes += Buffer.byteLength(options.body);
  try {
    const response = await fetch(url, options);
    if (!response.ok) httpErrors++;
    return response;
  } catch (error) {
    httpErrors++;
    throw error;
  }
};
const samples: {
  round: number;
  mode: string;
  calls: number;
  requestBytes: number;
  elapsedMs: number;
  errors: number;
  results: unknown;
  correct: number;
}[] = [];
const modes = ['sequential', 'parallel', 'batch'] as const;
for (let round = 0; round < 3; round++) {
  // 轮换次序减少固定冷启动位置影响；不改变生产超时和阈值。
  const order = [...modes.slice(round), ...modes.slice(0, round)];
  for (const mode of order) {
    const start = performance.now(),
      before = calls,
      bytes = requestBytes,
      errors = httpErrors;
    let results: Record<string, RequirementCheck['status']> = {};
    if (mode === 'batch')
      results = await judgeRequirements(checks, { request });
    else if (mode === 'parallel')
      results = Object.assign(
        {},
        ...(await Promise.all(
          checks.map((check) => judgeRequirements([check], { request })),
        )),
      );
    else
      for (const check of checks)
        Object.assign(results, await judgeRequirements([check], { request }));
    const sample = {
      round: round + 1,
      mode,
      calls: calls - before,
      requestBytes: requestBytes - bytes,
      elapsedMs: Math.round(performance.now() - start),
      errors: httpErrors - errors,
      results,
      correct: cases.filter(
        (entry, i) => results[`synthetic-${i}`] === entry[2],
      ).length,
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}
const f = fixture();
const parts = f.runtime.result!.plans[1].parts.map((part) =>
  f.catalog.parts.find((p) => p.id === part.id)!,
);
const semantic: RequirementItem = {
  id: 'appearance',
  text: cases[0][0],
  sourceMessageId: 'synthetic',
  strength: 'hard',
  active: true,
  version: 1,
  rule: 'semantic',
  category: 'case',
  field: 'appearance',
  expected: cases[0][0],
};
parts.find((part) => part.category === 'case')!.specs.appearance = cases[0][1];
const r = completeRequirements({
  ...f.runtime.draft,
  requirementItems: [semantic],
});
const gateSamples: {
  scenario: string;
  calls: number;
  elapsedMs: number;
  result: string;
}[] = [];
async function measure(scenario: string, work: () => Promise<unknown>) {
  const start = performance.now(),
    before = calls;
  const result = await work();
  gateSamples.push({
    scenario,
    calls: calls - before,
    elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    result: 'assertions passed',
  });
  return result;
}
await measure('rule_only', async () => {
  const result = await acceptRequirements(
    parts,
    { ...r, requirementItems: [] },
    8000,
    f.catalog.parts,
    undefined,
    { request },
  );
  assert.equal(result.passed, true);
});
await measure('rule_failure_before_semantic', async () => {
  await assert.rejects(
    acceptRequirements(parts, r, 9000, f.catalog.parts, undefined, { request }),
    /需求验收未通过/,
  );
});
await measure('missing_evidence_before_semantic', async () => {
  const candidate = structuredClone(parts);
  delete candidate.find((part) => part.category === 'case')!.specs.appearance;
  await assert.rejects(
    acceptRequirements(candidate, r, 8000, f.catalog.parts, undefined, {
      request,
    }),
    /无法确认/,
  );
});
let receipt: Awaited<ReturnType<typeof acceptRequirements>> | undefined;
await measure('first_semantic_acceptance', async () => {
  receipt = await acceptRequirements(
    parts,
    r,
    8000,
    f.catalog.parts,
    undefined,
    { request },
  );
  assert.equal(receipt.passed, true);
});
await measure('unchanged_5_rechecks', async () => {
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await acceptRequirements(
          parts,
          r,
          8000,
          f.catalog.parts,
          undefined,
          { request },
          receipt,
        )
      ).passed,
      true,
    );
});
await measure('changed_requirement_invalidates_receipt', async () => {
  const changed = {
    ...r,
    requirementItems: [
      {
        ...semantic,
        version: 2,
        expected: '必须具有明显RGB灯光',
        text: '必须具有明显RGB灯光',
      },
    ],
  };
  await assert.rejects(
    acceptRequirements(
      parts,
      changed,
      8000,
      f.catalog.parts,
      undefined,
      { request },
      receipt,
    ),
    /需求验收未通过/,
  );
});
for (const sample of gateSamples)
  assert.equal(
    sample.calls,
    [
      'first_semantic_acceptance',
      'changed_requirement_invalidates_receipt',
    ].includes(sample.scenario)
      ? 1
      : 0,
    sample.scenario,
  );
const summary = modes.map((mode) => {
  const rows = samples.filter((sample) => sample.mode === mode);
  return {
    mode,
    medianMs: rows.map((row) => row.elapsedMs).sort((a, b) => a - b)[1],
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    correct: rows.reduce((sum, row) => sum + row.correct, 0),
    judgments: rows.length * cases.length,
    requestBytes: rows.reduce((sum, row) => sum + row.requestBytes, 0),
    errors: rows.reduce((sum, row) => sum + row.errors, 0),
  };
});
const report = {
  createdAt: new Date().toISOString(),
  scope:
    'Jev requirement acceptance only; synthetic ablation, not historical release comparison or whole-agent benchmark',
  rounds: 3,
  cases,
  samples,
  summary,
  gateSamples,
  totalCalls: calls,
  httpErrors,
  tokenUsage: 'not measured; request bytes are not tokens or billed cost',
  thresholds: {
    confidence: process.env.JEV_REQUIREMENT_CONFIDENCE ?? '0.8',
    probability: process.env.JEV_REQUIREMENT_PROBABILITY ?? '0.9',
  },
};
await mkdir('reports', { recursive: true });
await writeFile(
  'reports/jev-acceptance-benchmark.json',
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    { summary, gateSamples, totalCalls: calls, httpErrors },
    null,
    2,
  ),
);
