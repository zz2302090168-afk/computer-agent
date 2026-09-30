import { config } from 'dotenv';
import { judgeRequirements } from '../agent/jev-requirements';
import type { RequirementCheck } from '../domain/requirement-acceptance';
import { mkdir, writeFile } from 'node:fs/promises';

config({ path: '.env.local', quiet: true });
const cases = [
  {
    text: '机箱外观要简洁，不要明显灯光装饰',
    actual: '纯黑封闭面板，无灯带、无RGB灯扇',
    expectedStatus: 'pass',
  },
  {
    text: '机箱外观要简洁，不要明显灯光装饰',
    actual: '正面三条RGB灯带，四把发光风扇',
    expectedStatus: 'fail',
  },
  {
    text: '机箱外观要简洁，不要明显灯光装饰',
    actual: '商品资料只写了机箱型号，未提供外观说明或图片',
    expectedStatus: 'unknown',
  },
  {
    text: '机箱不要花哨，但可以有一个普通电源指示灯',
    actual: '无装饰灯光，仅有单个普通电源指示灯，纯色面板',
    expectedStatus: 'pass',
  },
  {
    text: '不要明显的游戏风格装饰',
    actual: '红黑撞色、尖锐线条、巨大电竞龙形标志',
    expectedStatus: 'fail',
  },
];
const checks: RequirementCheck[] = cases.map((entry, index) => ({
  requirementId: `synthetic-${index}`,
  text: entry.text,
  strength: 'hard',
  expected: entry.text,
  actual: entry.actual,
  evidence: [{ source: 'synthetic fixture', description: entry.actual }],
  missingInformation: [],
  status: 'unknown',
}));
let calls = 0;
const start = performance.now();
const results = process.env.TYPESAFE_API_KEY
  ? await judgeRequirements(checks, {
      request: async (...args) => {
        calls++;
        return fetch(...args);
      },
    })
  : {};
const report = {
  executed: !!process.env.TYPESAFE_API_KEY,
  reason: process.env.TYPESAFE_API_KEY ? undefined : 'missing credentials',
  calls,
  elapsedMs: Math.round(performance.now() - start),
  thresholds: {
    confidence: Number(process.env.JEV_REQUIREMENT_CONFIDENCE ?? '.8'),
    probability: Number(process.env.JEV_REQUIREMENT_PROBABILITY ?? '.9'),
    calibrated: false,
  },
  cases: cases.map((entry, index) => ({
    ...entry,
    result: results[`synthetic-${index}`] ?? 'not_run',
  })),
};
await mkdir('reports', { recursive: true });
await writeFile(
  'reports/requirement-acceptance-live.json',
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
