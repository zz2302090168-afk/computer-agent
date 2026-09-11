import { knowledge } from '../../knowledge/library';

export type EmbeddingConfig = { key?: string; base?: string; model?: string };

type EmbeddingResponse = {
  data?: { embedding?: unknown; index?: unknown }[];
};

const corpusCache = new Map<string, Promise<number[][]>>();

function documentText(item: (typeof knowledge)[number]) {
  return `${item.title}\n${item.tags.join(' ')}\n${item.content}`;
}

async function embed(
  config: EmbeddingConfig,
  input: string[],
  signal?: AbortSignal,
) {
  if (!config.key || !config.base || !config.model)
    throw Error('Embedding 配置缺失，请在服务端配置 API。');
  const url = new URL(config.base);
  if (url.protocol !== 'https:') throw Error('Embedding 地址必须使用 HTTPS');
  const response = await fetch(url.href.replace(/\/$/, '') + '/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.any([
      AbortSignal.timeout(90000),
      ...(signal ? [signal] : []),
    ]),
    body: JSON.stringify({ model: config.model, input, encoding_format: 'float' }),
  });
  if (!response.ok)
    throw Error(`Embedding 连接失败（HTTP ${response.status}），请稍后重试。`);
  const payload = (await response.json()) as EmbeddingResponse;
  if (!Array.isArray(payload.data) || payload.data.length !== input.length)
    throw Error('Embedding 服务返回数量异常');
  const vectors: number[][] = Array(input.length);
  for (const item of payload.data) {
    if (
      !Number.isInteger(item.index) ||
      (item.index as number) < 0 ||
      (item.index as number) >= input.length
    )
      throw Error('Embedding 服务返回索引异常');
    if (
      !Array.isArray(item.embedding) ||
      !item.embedding.length ||
      !item.embedding.every((value) => Number.isFinite(value))
    )
      throw Error('Embedding 服务返回向量异常');
    const vector = item.embedding as number[];
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm <= 0)
      throw Error('Embedding 服务返回无效向量');
    if (vectors[item.index as number]) throw Error('Embedding 服务返回重复索引');
    vectors[item.index as number] = vector;
  }
  const dimensions = vectors[0]!.length;
  if (vectors.some((vector) => !vector || vector.length !== dimensions))
    throw Error('Embedding 服务返回向量维度不一致');
  return vectors;
}

function corpusVectors(config: EmbeddingConfig) {
  const texts = knowledge.map(documentText);
  const key = JSON.stringify([config.base, config.model, texts]);
  let pending = corpusCache.get(key);
  if (!pending) {
    pending = embed(config, texts);
    corpusCache.set(key, pending);
    pending.catch(() => corpusCache.delete(key));
  }
  return pending;
}

function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw Error('Embedding 查询与语料向量维度不一致');
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index]! * b[index]!;
  const score = dot / (Math.hypot(...a) * Math.hypot(...b));
  if (!Number.isFinite(score)) throw Error('Embedding 相似度计算失败');
  return score;
}

export async function retrieveKnowledge(
  config: EmbeddingConfig,
  query: string,
  limit = 4,
  category: 'support' | 'sales' = 'sales',
  topicId?: string,
  signal?: AbortSignal,
) {
  if (!query.trim()) throw Error('知识查询内容不能为空');
  const [vectors, [queryVector]] = await Promise.all([
    corpusVectors(config),
    embed(config, [query], signal),
  ]);
  signal?.throwIfAborted();
  return knowledge
    .map((item, index) => ({ item, vector: vectors[index]! }))
    .filter(
      ({ item }) =>
        (category === 'support'
          ? item.category === 'support'
          : item.category !== 'support') &&
        (!topicId || ('topicId' in item && item.topicId === topicId)),
    )
    .map(({ item, vector }) => ({
      ...item,
      score: cosine(queryVector!, vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(10, limit)));
}
