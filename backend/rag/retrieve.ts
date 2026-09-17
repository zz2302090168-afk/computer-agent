import {
  traceEvent,
  traceOperation,
  traceSync,
} from '../diagnostics/chat-trace';
import { knowledge } from '../../knowledge/library';

export type EmbeddingConfig = { key?: string; base?: string; model?: string };

type EmbeddingResponse = {
  usage?: { prompt_tokens?: number; total_tokens?: number };
  data?: { embedding?: unknown; index?: unknown }[];
};

function documentText(item: (typeof knowledge)[number]) {
  return `${item.title}\n${item.tags.join(' ')}\n${item.content}`;
}

export async function embed(
  config: EmbeddingConfig,
  input: string[],
  signal?: AbortSignal,
) {
  if (!input.length) throw Error('Embedding 输入不能为空');
  // 当前 flash 服务实测多输入返回重复 index，单条请求才能明确关联文本。
  // 不按数组位置猜测、不失败重试；普通 qwen3.7 遵守官方每批 20 条上限。
  const batchSize =
    config.model === 'qwen3.7-text-embedding-flash'
      ? 1
      : config.model === 'qwen3.7-text-embedding'
        ? 20
        : input.length;
  const controller = new AbortController();
  const deadline = AbortSignal.any([
    AbortSignal.timeout(90000),
    controller.signal,
    ...(signal ? [signal] : []),
  ]);
  const vectors: number[][] = Array(input.length);
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(4, Math.ceil(input.length / batchSize)) },
      async () => {
        try {
          while (cursor < input.length) {
            deadline.throwIfAborted();
            const offset = cursor;
            cursor += batchSize;
            const batch = await embedBatch(
              config,
              input.slice(offset, offset + batchSize),
              deadline,
            );
            batch.forEach((vector, index) => {
              vectors[offset + index] = vector;
            });
          }
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      },
    ),
  );
  if (vectors.some((vector) => vector.length !== vectors[0]!.length))
    throw Error('Embedding 服务返回向量维度不一致');
  return vectors;
}

async function embedBatch(
  config: EmbeddingConfig,
  input: string[],
  signal: AbortSignal,
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
    signal,
    body: JSON.stringify({
      model: config.model,
      input,
      encoding_format: 'float',
    }),
  });
  if (!response.ok)
    throw Error(`Embedding 连接失败（HTTP ${response.status}），请稍后重试。`);
  const payload = (await response.json()) as EmbeddingResponse;
  traceEvent('embedding.usage', {
    model: config.model,
    usage: payload.usage ?? null,
    inputCount: input.length,
  });
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
    if (vectors[item.index as number])
      throw Error('Embedding 服务返回重复索引');
    vectors[item.index as number] = vector;
  }
  const dimensions = vectors[0]!.length;
  if (vectors.some((vector) => !vector || vector.length !== dimensions))
    throw Error('Embedding 服务返回向量维度不一致');
  return vectors;
}

function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw Error('Embedding 查询与语料向量维度不一致');
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index]! * b[index]!;
  const score = dot / (Math.hypot(...a) * Math.hypot(...b));
  if (!Number.isFinite(score)) throw Error('Embedding 相似度计算失败');
  return score;
}

// 工厂仅供离线对照隔离索引；线上使用下方默认实例，不暴露实验开关给请求。
export function createKnowledgeRetriever(
  textForEmbedding = documentText,
  embedCorpus = embed,
) {
  const corpusCache = new Map<
    string,
    { pending: Promise<number[][]>; ready: boolean }
  >();
  function corpusVectors(config: EmbeddingConfig) {
    const texts = traceSync('rag.document_text', {}, () =>
      knowledge.map(textForEmbedding),
    );
    const key = JSON.stringify([config.base, config.model, texts]);
    let entry = corpusCache.get(key);
    const cacheState = !entry ? 'cold' : entry.ready ? 'hit' : 'wait';
    if (!entry) {
      const pending = traceOperation(
        'rag.corpus_generate',
        { model: config.model, count: texts.length },
        () => embedCorpus(config, texts),
        false,
      );
      entry = { pending, ready: false };
      corpusCache.set(key, entry);
      const created = entry;
      pending.then(
        () => {
          created.ready = true;
        },
        () => {
          corpusCache.delete(key);
        },
      );
    }
    const pending = entry.pending;
    return traceOperation(
      'rag.corpus_cache',
      { cacheState },
      () => pending,
      false,
    );
  }
  return async function retrieveKnowledge(
    config: EmbeddingConfig,
    query: string,
    limit = 4,
    category: 'support' | 'sales' = 'sales',
    topicId?: string,
    signal?: AbortSignal,
  ) {
    return traceOperation(
      'rag.retrieve',
      { queryId: crypto.randomUUID(), query, limit, category, topicId },
      async () => {
        if (!query.trim()) throw Error('知识查询内容不能为空');
        const [vectors, [queryVector]] = await Promise.all([
          corpusVectors(config),
          traceOperation(
            'rag.query_embedding',
            { model: config.model },
            () => embed(config, [query], signal),
            false,
          ),
        ]);
        signal?.throwIfAborted();
        return traceSync('rag.filter_rank', { category, topicId, limit }, () =>
          knowledge
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
            .slice(0, Math.max(1, Math.min(10, limit))),
        );
      },
    );
  };
}

export const retrieveKnowledge = createKnowledgeRetriever();
