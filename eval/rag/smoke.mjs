// 当前桌面版本的小样本连通验证；不替代冻结消融或完整业务评测。
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { knowledge } from '../../knowledge/library.ts';
import { retrieveKnowledge } from '../../backend/rag/retrieve.ts';
import { chatCompletion } from '../../backend/agent/chat-model.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';

const settings = {
  ...parse(readFileSync(process.env.EVAL_ENV_FILE ?? '.env.local')),
  ...process.env,
};
for (const [key, value] of Object.entries(settings))
  if (/^(MODEL_|EMBEDDING_|JUDGE_)/.test(key)) process.env[key] = value;
const configFor = (prefix) => ({
  key: settings[`${prefix}_API_KEY`],
  base: settings[`${prefix}_BASE_URL`],
  model: settings[`${prefix}_NAME`] ?? settings[`${prefix}_MODEL`],
});
const model = configFor('MODEL');
const runId = `migration-smoke-${new Date().toISOString().replaceAll(':', '-')}`;
const directory = resolve('eval/results', runId);
mkdirSync(directory, { recursive: true });
const hash = (data) => createHash('sha256').update(data).digest('hex');
const hashes = {};
for (const file of [
  'config.v2.json',
  'judge.schema.json',
  'judge-prompt.v1.txt',
  'judge-prompt.v4.txt',
  'judge-prompt.v6.txt',
]) {
  const content = readFileSync(`eval/rag/${file}`);
  const name = file === 'config.v2.json' ? 'config.v1.json' : file;
  writeFileSync(`${directory}/${name}`, content);
  hashes[name] = hash(content);
}
writeFileSync(
  `${directory}/manifest.json`,
  JSON.stringify(
    {
      runId,
      model: model.model,
      hashes,
      scope: 'migration_connectivity_only',
      humanVerified: false,
      corpusHash: hash(JSON.stringify(knowledge)),
      sourceHashes: Object.fromEntries(
        [
          'backend/rag/retrieve.ts',
          'backend/agent/chat-model.ts',
          'eval/rag/score.py',
          'eval/rag/smoke.mjs',
        ].map((file) => [file, hash(readFileSync(file))]),
      ),
    },
    null,
    2,
  ),
);
console.log(`RESULT_DIR=${directory}`);
const query = 'DDR4和DDR5内存能混用吗？';
for (const variant of ['current_retrieval', 'frozen_context']) {
  const trace = createChatTrace({ runId, variant }, directory);
  const row = {
    runId,
    traceId: trace.traceId,
    caseId: 'MIG01',
    split: 'smoke',
    variant,
    scope:
      variant === 'current_retrieval'
        ? 'production_retrieval_answer_replay'
        : 'synthetic_context_judge_connectivity',
    query,
    reference: 'DDR4与DDR5不能混用，应核对主板支持的内存类型。',
    mustStop: false,
    status: 'success',
  };
  await trace.run(async () => {
    const started = performance.now();
    try {
      row.contexts =
        variant === 'current_retrieval'
          ? (await retrieveKnowledge(configFor('EMBEDDING'), query)).map(
              (item) => ({ id: item.id, text: item.content }),
            )
          : [
              {
                id: 'synthetic-memory',
                text: 'DDR4与DDR5不能混用，应核对主板支持的内存类型。',
              },
            ];
      row.answer =
        (
          await chatCompletion(
            model,
            [
              {
                role: 'system',
                content: readFileSync(
                  'eval/rag/generation-prompt.v1.txt',
                  'utf8',
                ),
              },
              {
                role: 'user',
                content: `问题：${query}\n资料：${JSON.stringify(row.contexts)}`,
              },
            ],
            [],
            'none',
          )
        ).content ?? '';
    } catch (error) {
      row.status = 'failed';
      row.errorType = error.name;
    }
    row.applicationMs = performance.now() - started;
    trace.record('end', { status: row.status });
  });
  appendFileSync(`${directory}/applications.jsonl`, `${JSON.stringify(row)}\n`);
  console.log(`${variant}: ${row.status}`);
}
