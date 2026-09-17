import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { knowledge } from '../../knowledge/library.ts';
const config = parse(
  readFileSync(
    process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
  ),
);
const response = await fetch(
  config.EMBEDDING_BASE_URL.replace(/\/$/, '') + '/embeddings',
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.EMBEDDING_MODEL,
      input: knowledge
        .slice(0, 2)
        .map((k) => `${k.title}\n${k.tags.join(' ')}\n${k.content}`),
      encoding_format: 'float',
    }),
  },
);
const result = await response.json();
const inputs = knowledge
  .slice(0, 2)
  .map((k) => `${k.title}\n${k.tags.join(' ')}\n${k.content}`);
const singles = [];
for (const input of inputs) {
  const single = await fetch(
    config.EMBEDDING_BASE_URL.replace(/\/$/, '') + '/embeddings',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.EMBEDDING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.EMBEDDING_MODEL,
        input: [input],
        encoding_format: 'float',
      }),
      signal: AbortSignal.timeout(90000),
    },
  );
  const payload = await single.json();
  singles.push(payload.data?.[0]?.embedding);
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  return (
    a.reduce((sum, x, i) => sum + x * b[i], 0) /
    (Math.hypot(...a) * Math.hypot(...b))
  );
}
let message = String(
  result.error?.message ?? result.message ?? 'No diagnostic message',
);
for (const [name, value] of Object.entries(config))
  if (/key|secret|token|password/i.test(name) && value)
    message = message.replaceAll(value, '[REDACTED]');
console.log(
  JSON.stringify({
    indices: result.data?.map((x) => x.index),
    fields: result.data?.map((x) => Object.keys(x)),
    textIndices: result.data?.map((x) => x.text_index ?? null),
    batchToSingleCosines: result.data?.map((x) =>
      singles.map((v) => cosine(x.embedding, v)),
    ),
    count: result.data?.length,
    status: response.status,
    code: result.error?.code ?? result.code,
    message: message.slice(0, 800),
  }),
);
