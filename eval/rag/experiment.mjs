// v2: 冻结后先开发集选择，再测试；共用正式传输和检索函数。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
import { knowledge } from '../../knowledge/library.ts';
import { createKnowledgeRetriever } from '../../backend/rag/retrieve.ts';
import { chatCompletion } from '../../backend/agent/chat-model.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';

const root = new URL('./', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const config = JSON.parse(read('config.v2.json'));
const dataset = JSON.parse(read('dataset.v2.json'));
if (JSON.parse(read('corpus.v2.json')).corpusHash !== hash(JSON.stringify(knowledge)))
  throw Error('语料已变化，须核验标注并创建新实验版本，不能覆盖v2基线');
const dev = JSON.parse(read('dataset.v1.json')).cases.map((q) => ({
  ...q,
  split: 'dev',
  evidenceGroups: dataset.devEvidenceGroups[q.id],
}));
const heldout = dataset.test.map((q) => ({ ...q, split: 'test' }));
for (const q of [...dev, ...heldout])
  for (const group of q.evidenceGroups)
    for (const id of group)
      if (!knowledge.some((k) => k.id === id))
        throw Error(`无效证据 ${q.id}/${id}`);
const settings = {
  ...parse(
    readFileSync(
      process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
    ),
  ),
  ...process.env,
};
for (const [key, value] of Object.entries(settings))
  if (/^(MODEL_|EMBEDDING_|JUDGE_)/.test(key)) process.env[key] = value;
const embedding = {
  key: settings.EMBEDDING_API_KEY,
  base: settings.EMBEDDING_BASE_URL,
  model: settings.EMBEDDING_MODEL,
};
const model = {
  key: settings.MODEL_API_KEY,
  base: settings.MODEL_BASE_URL,
  model: settings.MODEL_NAME,
};
const runId = 'v2-' + new Date().toISOString().replaceAll(':', '-');
const output = new URL(`../results/${runId}/`, root);
mkdirSync(output, { recursive: true });
const save = (name, value) =>
  writeFileSync(new URL(name, output), JSON.stringify(value, null, 2));
const append = (name, value) =>
  appendFileSync(new URL(name, output), JSON.stringify(value) + '\n');
const frozen = [
  'config.v2.json',
  'dataset.v1.json',
  'dataset.v2.json',
  'generation-prompt.v1.txt',
  'judge.schema.json',
  'judge-prompt.v1.txt',
  'judge-prompt.v4.txt',
  'corpus.v2.json',
];
const hashes = Object.fromEntries(
  frozen.map((f) => {
    writeFileSync(new URL(f, output), read(f));
    return [f, hash(read(f))];
  }),
);
// 兼容现有汇总入口；原始文件和指纹保留v2名称。
save('config.v1.json', config);
const corpus = {
  corpusHash: hash(JSON.stringify(knowledge)),
  evidence: knowledge.map((k) => ({
    id: k.id,
    title: k.title,
    sha256: hash(k.content),
  })),
};
save('corpus.v2.json', corpus);
save('manifest.json', {
  runId,
  config,
  hashes,
  corpusHash: corpus.corpusHash,
  model: model.model,
  embeddingModel: embedding.model,
  humanVerified: false,
  scope: 'offline_answer_replay_using_production_retrieval',
  sourceHashes: Object.fromEntries(
    [
      '../../backend/rag/retrieve.ts',
      '../../backend/agent/chat-model.ts',
      'experiment.mjs',
    ].map((f) => [f, hash(read(f))]),
  ),
});
console.log(
  `RESULT_DIR=${decodeURIComponent(output.pathname).replace(/^\/(\w:)/, '$1')}`,
);
const retrievers = {
  full: createKnowledgeRetriever(),
  tags_body: createKnowledgeRetriever(
    (k) => `${k.tags.join(' ')}\n${k.content}`,
  ),
  title_body: createKnowledgeRetriever((k) => `${k.title}\n${k.content}`),
  body: createKnowledgeRetriever((k) => k.content),
};
function context(hits) {
  let remaining = config.contextBudget.limit;
  return hits.flatMap((hit) => {
    const text = `[${hit.id}] ${hit.title}\n${hit.content}`;
    const length = Array.from(text).length;
    if (length > remaining) return [];
    remaining -= length;
    return [{ id: hit.id, text, sha256: hash(hit.content) }];
  });
}
function metrics(q, docs) {
  const ids = docs.map((d) => d.id),
    all = new Set(q.evidenceGroups.flat());
  const first = ids.findIndex((id) => all.has(id));
  return {
    claimCoverage: q.evidenceGroups.length
      ? q.evidenceGroups.filter((g) => g.some((id) => ids.includes(id)))
          .length / q.evidenceGroups.length
      : null,
    labelledPrecision: q.evidenceGroups.length
      ? ids.filter((id) => all.has(id)).length / ids.length
      : null,
    reciprocalRank: all.size ? (first < 0 ? 0 : 1 / (first + 1)) : null,
    contextCodepoints: docs.reduce((n, d) => n + Array.from(d.text).length, 0),
  };
}
const mean = (xs) => {
  xs = xs.filter((x) => x !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const devRows = [];
for (const [i, q] of dev.entries()) {
  const queryRanks = new Map();
  for (const variant of i % 2
    ? [...config.variants].reverse()
    : config.variants) {
    const trace = createChatTrace({
      runId,
      queryId: q.id,
      variant: variant.id,
      phase: 'dev_retrieval',
    });
    const started = performance.now();
    const row = {
      caseId: q.id,
      variant: variant.id,
      split: 'dev',
      traceId: trace.traceId,
    };
    await trace.run(async () => {
      // 同一文本方案的top-k扫描共享这次排序，避免把向量请求波动当作k的收益。
      if (!queryRanks.has(variant.text))
        queryRanks.set(
          variant.text,
          await retrievers[variant.text](
            embedding,
            q.query,
            10,
            q.category,
            q.topicId,
          ),
        );
      const hits = queryRanks.get(variant.text).slice(0, variant.topK);
      row.retrievedIds = hits.map((h) => h.id);
      row.metrics = metrics(q, context(hits));
      row.durationMs = performance.now() - started;
      trace.record('end', { status: 'success', durationMs: row.durationMs });
    });
    row.usage = readFileSync(trace.file, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter((e) => e.event === 'embedding.usage')
      .map((e) => e.data.data);
    devRows.push(row);
    append('development.jsonl', row);
  }
  console.log(`开发集 ${q.id} 完成`);
}
const summary = config.variants.map((v) => ({
  ...v,
  ...Object.fromEntries(
    [
      'claimCoverage',
      'labelledPrecision',
      'reciprocalRank',
      'contextCodepoints',
    ].map((metric) => [
      metric,
      mean(
        devRows.filter((r) => r.variant === v.id).map((r) => r.metrics[metric]),
      ),
    ]),
  ),
}));
summary.sort(
  (a, b) =>
    b.claimCoverage - a.claimCoverage ||
    b.labelledPrecision - a.labelledPrecision ||
    b.reciprocalRank - a.reciprocalRank ||
    a.contextCodepoints - b.contextCodepoints,
);
const selected = summary[0];
// 即使原基线获胜，也报告预先规定的最佳非基线对照，不称它为优化成功。
const challenger = summary.find((v) => v.id !== 'baseline');
save('selection.json', {
  selected: selected.id,
  challenger: challenger.id,
  rule: config.selection,
  development: summary,
  frozenBeforeTest: new Date().toISOString(),
});
console.log(`开发集选择 ${selected.id}；最终对照 baseline / ${challenger.id}`);
const variants = [config.variants[0], challenger];
for (const [i, q] of heldout.entries())
  for (const variant of i % 2 ? [...variants].reverse() : variants) {
    const started = performance.now();
    const trace = createChatTrace({
      runId,
      queryId: q.id,
      variant: variant.id,
      phase: 'heldout',
    });
    const row = {
      schemaVersion: 'pc-rag-result-v1',
      runId,
      traceId: trace.traceId,
      caseId: q.id,
      split: 'test',
      variant: variant.id,
      scope: 'offline_answer_replay',
      query: q.query,
      reference: q.reference,
      mustStop: q.mustStop,
      evidenceGroups: q.evidenceGroups,
      status: 'success',
    };
    await trace.run(async () => {
      try {
        const retrievalStart = performance.now();
        const hits = await retrievers[variant.text](
          embedding,
          q.query,
          variant.topK,
          q.category,
          q.topicId,
        );
        row.retrievalMs = performance.now() - retrievalStart;
        row.retrievedIds = hits.map((h) => h.id);
        row.contexts = context(hits);
        row.program = metrics(q, row.contexts);
        row.contextCodepoints = row.program.contextCodepoints;
        const answer = await chatCompletion(
          model,
          [
            { role: 'system', content: read('generation-prompt.v1.txt') },
            {
              role: 'user',
              content: `问题：${q.query}\n检索证据：\n${row.contexts.map((c) => c.text).join('\n\n')}`,
            },
          ],
          [],
          'none',
          undefined,
          () => {
            row.firstTextMs ??= performance.now() - started;
          },
        );
        row.answer = answer.content ?? '';
      } catch (error) {
        row.status = 'failed';
        row.error = { type: error.name, message: error.message };
      }
      row.applicationMs = performance.now() - started;
      trace.record('end', {
        status: row.status,
        durationMs: row.applicationMs,
      });
    });
    const events = readFileSync(trace.file, 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    row.usage = events
      .filter((e) => ['model.usage', 'embedding.usage'].includes(e.event))
      .map((e) => ({ ...e.data.data, kind: e.event.split('.')[0] }));
    row.cacheState = events.find(
      (e) => e.event === 'rag.corpus_cache.start',
    )?.data.input.cacheState;
    append('applications.jsonl', row);
    console.log(
      `${q.id} ${variant.id} ${row.status} ${Math.round(row.applicationMs)}ms`,
    );
  }
