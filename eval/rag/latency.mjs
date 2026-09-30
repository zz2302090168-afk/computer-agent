import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { createKnowledgeRetriever } from '../../backend/rag/retrieve.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';

const output = resolve(process.argv[2]);
const config = JSON.parse(
  readFileSync(resolve(output, 'config.v2.json'), 'utf8'),
);
if (existsSync(resolve(output, 'retrieval-latency.jsonl')))
  throw Error('已有计时结果，不追加重复样本');
const selection = JSON.parse(
  readFileSync(resolve(output, 'selection.json'), 'utf8'),
);
const variants = config.variants.filter((v) =>
  ['baseline', selection.challenger].includes(v.id),
);
const settings = {
  ...parse(
    readFileSync(
      process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
    ),
  ),
  ...process.env,
};
for (const key of [
  'EMBEDDING_API_KEY',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_MODEL',
])
  process.env[key] = settings[key];
const embedding = {
  key: settings.EMBEDDING_API_KEY,
  base: settings.EMBEDDING_BASE_URL,
  model: settings.EMBEDDING_MODEL,
};
// 只重复检索，避免反复生成和评分。每次新建两套索引，冷/热各对称两次。
for (let repeat = 0; repeat < 2; repeat++) {
  const retrievers = Object.fromEntries(
    variants.map((v) => [
      v.id,
      createKnowledgeRetriever(
        v.text === 'full'
          ? undefined
          : v.text === 'title_body'
            ? (item) => `${item.title}\n${item.content}`
            : v.text === 'tags_body'
              ? (item) => `${item.tags.join(' ')}\n${item.content}`
              : (item) => item.content,
      ),
    ]),
  );
  for (const phase of ['cold', 'hot']) {
    for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
      const trace = createChatTrace({
        experiment: config.version,
        kind: 'retrieval_latency_repeat',
        repeat,
        phase,
        variant: variant.id,
        queryId: 'D01',
      });
      const started = performance.now();
      const row = {
        repeat,
        phase,
        variant: variant.id,
        traceId: trace.traceId,
        status: 'success',
        usage: [],
        scope: 'retrieval_only_singleton_transport',
      };
      try {
        await trace.run(() =>
          retrievers[variant.id](
            embedding,
            'DDR4 内存能插在 DDR5 主板上吗？',
            variant.topK,
            'sales',
          ),
        );
      } catch (error) {
        row.status = 'failed';
        row.errorType = error.name;
      }
      row.durationMs = performance.now() - started;
      trace.record('end', { status: row.status, durationMs: row.durationMs });
      row.usage = readFileSync(trace.file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === 'embedding.usage')
        .map((e) => ({ ...e.data.data, kind: 'embedding' }));
      appendFileSync(
        resolve(output, 'retrieval-latency.jsonl'),
        JSON.stringify(row) + '\n',
      );
      console.log(
        repeat,
        phase,
        variant.id,
        Math.round(row.durationMs) + 'ms',
        row.status,
      );
    }
  }
}
