import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKnowledgeRetriever, embed } from '../rag/retrieve';
import { createChatTrace, traceOperation } from '../diagnostics/chat-trace';
import { knowledge } from '../../knowledge/library';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';

void test('flash 单条并发保持输入对应关系，普通 qwen 每批不超过20条', async (t) => {
  const sizes: number[] = [];
  let active = 0,
    peak = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(options!.body as string);
      sizes.push(body.input.length);
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return Response.json({
        data: body.input
          .map((value: string, index: number) => ({
            index,
            embedding: [Number(value), 1],
          }))
          .reverse(),
      });
    },
  );
  const input = Array.from({ length: 98 }, (_, i) => String(i));
  const expected = input.map((x) => [Number(x), 1]);
  assert.deepEqual(
    await embed(
      { ...embeddingConfig, model: 'qwen3.7-text-embedding-flash' },
      input,
    ),
    expected,
  );
  assert.ok(sizes.every((n) => n === 1));
  assert.ok(peak <= 4);
  sizes.length = 0;
  assert.deepEqual(
    await embed({ ...embeddingConfig, model: 'qwen3.7-text-embedding' }, input),
    expected,
  );
  assert.deepEqual(sizes, [20, 20, 20, 20, 18]);
});

void test('分批失败不补交部分向量、不重试；跨批维度和重复索引仍拒绝', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { status: 400 });
  });
  await assert.rejects(
    embed(
      { ...embeddingConfig, model: 'qwen3.7-text-embedding-flash' },
      Array(98).fill('x'),
    ),
    /HTTP 400/,
  );
  assert.equal(calls, 4);
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options?: RequestInit) => {
      const { input } = JSON.parse(options!.body as string);
      return Response.json({
        data: [{ index: 0, embedding: input[0] === 'a' ? [1, 1] : [1, 1, 1] }],
      });
    },
  );
  await assert.rejects(
    embed({ ...embeddingConfig, model: 'qwen3.7-text-embedding-flash' }, [
      'a',
      'b',
    ]),
    /维度不一致/,
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [1] },
      ],
    }),
  );
  await assert.rejects(embed(embeddingConfig, ['a', 'b']), /重复索引/);
  await assert.rejects(embed(embeddingConfig, ['a'], AbortSignal.abort()), {
    name: 'AbortError',
  });
});

void test('计时区分共享索引等待和热命中；消融索引确实重新生成正文向量', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const directory = mkdtempSync(join(tmpdir(), 'rag-timing-'));
  try {
    const trace = createChatTrace({}, directory);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inputs: string[][] = [];
    const build = async (_config: typeof embeddingConfig, texts: string[]) => {
      inputs.push(texts);
      await gate;
      return texts.map(() => [1, 1, 1, 1, 1, 1, 1, 1]);
    };
    // 回调接受更宽的配置类型；只记录文本，不读取密钥。
    const retrieve = createKnowledgeRetriever(undefined, (_config, texts) =>
      build(embeddingConfig, texts),
    );
    await trace.run(async () => {
      const first = retrieve(embeddingConfig, 'DDR4');
      const second = retrieve(embeddingConfig, 'DDR5');
      release();
      await Promise.all([first, second]);
      await retrieve(embeddingConfig, '主板');
      const bodyOnly = createKnowledgeRetriever(
        (item) => item.content,
        (_config, texts) => build(embeddingConfig, texts),
      );
      await bodyOnly(embeddingConfig, 'DDR4');
      await assert.rejects(
        retrieve(
          embeddingConfig,
          '内存',
          4,
          'sales',
          undefined,
          AbortSignal.abort(),
        ),
        { name: 'AbortError' },
      );
      const previousNow = Date.now;
      Date.now = () => -1;
      try {
        await traceOperation('clock_test', {}, async () => 'ok');
      } finally {
        Date.now = previousNow;
      }
    });
    const events = readFileSync(trace.file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events
        .filter((e) => e.event === 'rag.corpus_cache.start')
        .map((e) => e.data.input.cacheState),
      ['cold', 'wait', 'hit', 'cold', 'hit'],
    );
    assert.equal(inputs.length, 2);
    assert.equal(
      inputs[0][0],
      `${knowledge[0].title}\n${knowledge[0].tags.join(' ')}\n${knowledge[0].content}`,
    );
    assert.equal(inputs[1][0], knowledge[0].content);
    assert.ok(events.every((e) => e.traceId === trace.traceId));
    assert.ok(
      events
        .filter((e) => e.data?.durationMs !== undefined)
        .every((e) => e.data.durationMs >= 0),
    );
    assert.equal(
      events.find((e) => e.event === 'rag.retrieve.error')?.data.status,
      'cancelled',
    );
    assert.ok(
      events
        .filter((e) => e.event === 'rag.corpus_generate.result')
        .every((e) => !Object.hasOwn(e.data, 'result')),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
