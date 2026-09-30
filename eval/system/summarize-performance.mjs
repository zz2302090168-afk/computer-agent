import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [root, outputName, ...labels] = process.argv.slice(2);
if (!root || !outputName || !labels.length)
  throw Error(
    '用法：node summarize-performance.mjs <快照目录> <新报告名.json> <运行名称...>',
  );
const target = `${root}/${outputName}`;
if (existsSync(target)) throw Error('报告已存在，不能覆盖');
const report = {
  scope:
    'Measured application calls; model and embedding separated; amounts unknown without account billing rates',
  quality: 'Program checks alone do not establish semantic success',
  runs: {},
};
for (const label of labels) {
  const rows = readFileSync(`${root}/${label}/applications.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const cases = rows.map((row) => {
    const usage = {
      model: { calls: 0, input: 0, output: 0, total: 0, unknownUsageCalls: 0 },
      embedding: {
        calls: 0,
        input: 0,
        output: 0,
        total: 0,
        unknownUsageCalls: 0,
      },
    };
    for (const entry of row.usage ?? []) {
      const group = usage[entry.kind];
      if (!group) continue;
      group.calls++;
      const u = entry.usage;
      if (!u || !Number.isFinite(u.total_tokens)) group.unknownUsageCalls++;
      group.input += u?.prompt_tokens ?? 0;
      group.output += u?.completion_tokens ?? 0;
      group.total += u?.total_tokens ?? 0;
    }
    return {
      id: row.caseId,
      turn: row.turn,
      status: row.status,
      programPassed: row.checks?.programPassed ?? false,
      failures: row.checks?.failures ?? [],
      durationMs: row.durationMs,
      firstTextMs: row.firstTextMs ?? null,
      usage,
    };
  });
  const sorted = cases.map((row) => row.durationMs).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  report.runs[label] = {
    turns: cases.length,
    programPassed: cases.filter((row) => row.programPassed).length,
    medianSeconds: sorted.length
      ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2000
      : null,
    totalSeconds: sorted.reduce((sum, value) => sum + value, 0) / 1000,
    modelTokens: cases.reduce((sum, row) => sum + row.usage.model.total, 0),
    embeddingTokens: cases.reduce(
      (sum, row) => sum + row.usage.embedding.total,
      0,
    ),
    modelCallsWithUsage: cases.reduce(
      (sum, row) => sum + row.usage.model.calls,
      0,
    ),
    cases,
  };
}
writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
console.log(target);
