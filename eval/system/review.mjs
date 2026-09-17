import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const root = process.argv[2];
if (!root) throw Error('需要冻结结果目录');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const lines = (path) =>
  readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const catalog = read(`${root}/catalog.json`);
const reviews = [];
for (const run of readdirSync(root)) {
  if (!existsSync(`${root}/${run}/applications.jsonl`)) continue;
  const manifest = read(`${root}/${run}/manifest.json`);
  for (const row of lines(`${root}/${run}/applications.jsonl`)) {
    const scene = manifest.dataset.cases.find((c) => c.id === row.caseId);
    const turn = scene.turns[row.turn];
    const events = lines(
      `${root}/${run}/${row.caseId}-${row.turn}.trace.jsonl`,
    );
    const toolResults = events
      .filter((e) => e.event === 'tool.result')
      .map((e) => e.data.result);
    const failures = (row.checks?.failures ?? []).map((f) => f.code);
    const corrections = [],
      limits = ['语义未由人工核验'];
    if (row.status !== 'success') failures.push('runtime_failure');
    if (row.caseId === 'B01') {
      const noMatches = !catalog.prebuilts.some(
        (p) => p.price >= 9000 && p.price <= 10000,
      );
      const d = row.finalState?.result?.budgetDiagnostic;
      if (
        noMatches &&
        d?.kind === 'budget_gap' &&
        d.searchComplete &&
        !row.finalState.result.plans.length
      ) {
        const index = failures.indexOf('no_plan');
        if (index >= 0) failures.splice(index, 1);
        corrections.push(
          '独立目录核对无9000至10000元整机，正确报告无解；原始判定保留',
        );
      }
    }
    const filter =
      row.caseId === 'B03'
        ? { category: 'cpu', brand: 'AMD' }
        : turn.catalogFilter;
    if (filter) {
      const expected = catalog.parts.filter(
        (p) =>
          p.category === filter.category &&
          p.brand.toLowerCase().includes(filter.brand.toLowerCase()) &&
          (filter.maxPrice === undefined || p.price <= filter.maxPrice),
      );
      const queries = toolResults
        .filter(
          (r) => r?.operation?.tool === 'search_catalog' && !r.operation.failed,
        )
        .map((r) => r.data);
      const appropriate = queries.some(
        (q) =>
          q.filters?.category === filter.category &&
          q.filters?.brand?.toLowerCase() === filter.brand.toLowerCase() &&
          q.filters?.maxPrice === filter.maxPrice &&
          q.matchCount === expected.length &&
          q.matches.every((p) => expected.some((e) => e.id === p.id)),
      );
      if (!appropriate) failures.push('catalog_filter_or_coverage');
      corrections.push(
        `独立目录应匹配${expected.length}件；核对价格过滤和结果数量`,
      );
    }
    if (row.caseId === 'H03' && !manifest.dataset.cases.find((c) => c.id === 'H03').turns.some((t) => t.expectedPlanIndex !== undefined))
      limits.push(
        '夹具未给三套配置标注均衡名称；仅核验选定/确认状态，不能声称选对均衡方案',
      );
    const modelUsage = row.usage.filter((u) => u.kind === 'model');
    reviews.push({
      run,
      caseId: row.caseId,
      turn: row.turn,
      originalChecks: row.checks,
      programFailures: [...new Set(failures)],
      corrections,
      limits,
      durationMs: row.durationMs,
      modelCalls: modelUsage.length,
      modelTokens: modelUsage.reduce(
        (n, u) => n + (u.usage?.total_tokens ?? 0),
        0,
      ),
    });
  }
}
const runs = {};
for (const row of reviews) {
  const s = (runs[row.run] ??= {
    turns: 0,
    programPassed: 0,
    programFailed: 0,
    modelCalls: 0,
    modelTokens: 0,
    failures: [],
  });
  s.turns++;
  s.programPassed += Number(!row.programFailures.length);
  s.programFailed += Number(!!row.programFailures.length);
  s.modelCalls += row.modelCalls;
  s.modelTokens += row.modelTokens;
  if (row.programFailures.length)
    s.failures.push({
      id: row.caseId,
      turn: row.turn,
      codes: row.programFailures,
    });
}
const result = {
  protocol: 'pilot-review-v2',
  humanVerified: false,
  warning:
    '程序通过数不是完整任务成功率；原始失败不删除，补充评审与旧判定并列。',
  runs,
  rows: reviews,
};
writeFileSync(`${root}/review.v2.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(runs, null, 2));
