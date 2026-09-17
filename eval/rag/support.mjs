import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import { parse } from 'dotenv';
import { createHash } from 'node:crypto';
import { runConversation } from '../../backend/agent/conversation.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';
import { knowledge } from '../../knowledge/library.ts';

const root = new URL('./', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const config = JSON.parse(read('config.v2.json'));
const settings = parse(
  readFileSync(
    process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
  ),
);
for (const [key, value] of Object.entries(settings))
  if (/^(MODEL_|EMBEDDING_)/.test(key) && process.env[key] === undefined)
    process.env[key] = value;
const model = {
  key: process.env.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME,
};
const embedding = {
  key: process.env.EMBEDDING_API_KEY,
  base: process.env.EMBEDDING_BASE_URL,
  model: process.env.EMBEDDING_MODEL,
};
const runId = 'support-' + new Date().toISOString().replaceAll(':', '-');
const destination = new URL(`../results/${runId}/`, root);
mkdirSync(destination, { recursive: true });
const hashes = {};
for (const file of [
  'config.v2.json',
  'judge-prompt.v1.txt',
  'judge.schema.json',
  'support-cases.v1.json',
]) {
  const value = read(file);
  writeFileSync(new URL(file, destination), value);
  hashes[file] = createHash('sha256').update(value).digest('hex');
}
writeFileSync(
  new URL('config.v1.json', destination),
  JSON.stringify(config, null, 2),
);
writeFileSync(
  new URL('manifest.json', destination),
  JSON.stringify(
    {
      runId,
      config,
      hashes,
      model: model.model,
      embeddingModel: embedding.model,
      scope:
        'real_runConversation_real_model_real_tools_memory_state_empty_catalog_support_only',
      humanVerified: false,
    },
    null,
    2,
  ),
);
const catalog = { parts: [], prebuilts: [] }; // 这些售后场景无需商品；不构造虚假商品，也不执行配机。
for (const item of JSON.parse(read('support-cases.v1.json')).cases) {
  const task = {
    id: crypto.randomUUID(),
    name: '离线售后评测',
    draft: item.initialSupport ? { support: item.initialSupport } : {},
    result: null,
    issues: [],
    version: 1,
    updatedAt: Date.now(),
  };
  const messageId = crypto.randomUUID();
  let saved = task;
  const trace = createChatTrace({
    runId,
    queryId: item.id,
    messageId,
    initialTask: task,
  });
  const row = {
    schemaVersion: 'pc-rag-result-v1',
    runId,
    traceId: trace.traceId,
    caseId: item.id,
    split: 'test',
    variant: 'production_support',
    scope: 'real_agent_support',
    query: item.query,
    reference: item.reference,
    mustStop: item.mustStop,
    status: 'success',
  };
  const started = performance.now();
  await trace.run(async () => {
    try {
      const output = await runConversation(
        model,
        {
          draft: task.draft,
          result: null,
          task,
          currentTaskId: task.id,
          messages: [],
        },
        item.query,
        messageId,
        catalog,
        async () => catalog,
        async (_type, draft, result) => {
          saved = { ...saved, draft, result, version: saved.version + 1 };
          return saved.version;
        },
        'offline-support',
        async () => {},
        () => {
          row.firstProgressMs ??= performance.now() - started;
        },
        AbortSignal.timeout(300000),
        embedding,
        undefined,
        () => {
          row.firstTextMs ??= performance.now() - started;
        },
      );
      row.answer = output.messages.at(-1)?.content ?? '';
      row.finalSupport = saved.draft.support ?? null;
      row.selectedStepId = row.finalSupport?.currentStepId ?? null;
      const deliveredThisTurn =
        row.finalSupport?.history?.at(-1)?.messageId === messageId;
      const step = knowledge.find((k) => k.id === row.selectedStepId);
      row.program = {
        stopped:
          row.finalSupport?.selfServiceStopped === true ||
          row.finalSupport?.status === 'stopped',
        stopStateMatches: item.mustStop
          ? row.finalSupport?.selfServiceStopped === true ||
            row.finalSupport?.status === 'stopped'
          : null,
        selectedStepMatchesProvisionalLabel: item.acceptableStepIds.length
          ? deliveredThisTurn &&
            item.acceptableStepIds.includes(row.selectedStepId)
          : null,
        verbatimSelectedStep:
          deliveredThisTurn && step ? row.answer.includes(step.content) : null,
        newStepAfterStop: item.mustStop
          ? Boolean(
              deliveredThisTurn && step && row.answer.includes(step.content),
            )
          : null,
      };
    } catch (error) {
      row.status = error.name === 'TimeoutError' ? 'timeout' : 'failed';
      row.error = { type: error.name, message: error.message };
    } finally {
      row.applicationMs = performance.now() - started;
      trace.record('end', {
        status: row.status,
        durationMs: row.applicationMs,
      });
    }
  });
  const events = readFileSync(trace.file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  row.toolCalls = events
    .filter((e) => e.event === 'tool.start')
    .map((e) => e.data.input);
  row.contexts = [
    ...new Set(
      events
        .filter((e) => e.event === 'tool.result')
        .flatMap((e) => {
          const result = e.data.result?.data ?? e.data.result;
          return (Array.isArray(result) ? result : (result?.evidence ?? []))
            .map((k) => k.id)
            .filter(Boolean);
        }),
    ),
  ].flatMap((id) => {
    const k = knowledge.find((k) => k.id === id);
    return k ? [{ id, text: k.content }] : [];
  });
  row.referenceEvidence = knowledge
    .filter(
      (k) =>
        item.acceptableStepIds.includes(k.id) ||
        (item.mustStop &&
          ['support-general-flow.7', 'support-no-power.7'].includes(k.id)),
    )
    .map((k) => ({ id: k.id, text: k.content }));
  row.usage = events
    .filter((e) => ['model.usage', 'embedding.usage'].includes(e.event))
    .map((e) => ({ ...e.data.data, kind: e.event.split('.')[0] }));
  row.spans = events
    .filter((e) => /\.(result|error)$/.test(e.event))
    .map((e) => ({
      stage: e.event,
      callId: e.data.callId,
      durationMs: e.data.durationMs,
      status: e.data.status,
    }));
  appendFileSync(
    new URL('applications.jsonl', destination),
    JSON.stringify(row) + '\n',
  );
  console.log(
    item.id,
    row.status,
    JSON.stringify(row.program),
    Math.round(row.applicationMs) + 'ms',
  );
}
console.log(
  'RESULT_DIR=' +
    decodeURIComponent(destination.pathname).replace(/^\/(\w:)/, '$1'),
);
