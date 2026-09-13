import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../agent/chat-model';

const config = {
  key: 'isolated-test-key',
  base: 'https://mock.invalid/v1',
  model: 'isolated-model',
};
const encoder = new TextEncoder();
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const finalText = (finishReason = 'stop') =>
  event({
    choices: [
      {
        index: 0,
        delta: { content: '配置说明已完成' },
        finish_reason: finishReason,
      },
    ],
  });

void test('文字片段在模型结束前立即交付', { timeout: 1000 }, async (t) => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const chunks: string[] = [];
  const completion = chatCompletion(
    config,
    [],
    [],
    'auto',
    undefined,
    (text) => {
      chunks.push(text);
      if (chunks.length === 1)
        controller.enqueue(
          encoder.encode(
            event({
              choices: [
                {
                  index: 0,
                  delta: { content: '用途？' },
                  finish_reason: 'stop',
                },
              ],
            }) + done,
          ),
        );
    },
  );
  controller.enqueue(
    encoder.encode(
      event({ choices: [{ index: 0, delta: { content: '预算和' } }] }),
    ),
  );
  const response = await completion;
  assert.deepEqual(chunks, ['预算和', '用途？']);
  assert.equal(response.content, '预算和用途？');
});

void test(
  '模型完成标记后立即返回并释放仍保持连接的流',
  { timeout: 1000 },
  async (t) => {
    let cancelled = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(encoder.encode(finalText() + done));
      },
      cancel() {
        cancelled = true;
      },
    });
    t.after(() => controller.error(new Error('测试结束')));
    t.mock.method(globalThis, 'fetch', async () => new Response(body));

    const response = await chatCompletion(config, [], []);

    assert.equal(response.content, '配置说明已完成');
    assert.equal(cancelled, true);
  },
);

void test('模型完成后连接断开不丢弃已经完整收到的回复', async (t) => {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (reads++ === 0)
          controller.enqueue(encoder.encode(finalText() + done));
        else controller.error(new Error('完成标记后连接断开'));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  t.mock.method(globalThis, 'fetch', async () => new Response(body));

  const response = await chatCompletion(config, [], []);

  assert.equal(response.content, '配置说明已完成');
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

void test('UTF-8网络分块与工具增量仍按调用编号重组工具名和参数', async (t) => {
  const payload =
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: 'second',
                function: { name: 'get_', arguments: '{' },
              },
              {
                index: 0,
                id: 'first',
                function: { name: 'search_', arguments: '{"query":"' },
              },
            ],
          },
        },
      ],
    }) +
    event({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: 'catalog', arguments: '黑色主板"}' },
              },
              { index: 1, function: { name: 'requirements', arguments: '}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }) +
    done;
  const bytes = encoder.encode(payload);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 2)
        controller.enqueue(bytes.slice(offset, offset + 2));
      controller.close();
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));

  const response = await chatCompletion(config, [], []);

  assert.equal(response.content, null);
  assert.deepEqual(response.tool_calls, [
    {
      id: 'first',
      type: 'function',
      function: { name: 'search_catalog', arguments: '{"query":"黑色主板"}' },
    },
    {
      id: 'second',
      type: 'function',
      function: { name: 'get_requirements', arguments: '{}' },
    },
  ]);
});

for (const [name, payload] of [
  [
    '连接关闭但缺少结束原因',
    event({ choices: [{ index: 0, delta: { content: '尚未完成' } }] }),
  ],
  ['仅有DONE而缺少结束原因', done],
  ['回复达到长度上限被截断', finalText('length') + done],
  ['DONE早于合法结束消息', done + finalText()],
]) {
  void test(`模型流不完整时拒绝交付：${name}`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(payload));
    await assert.rejects(
      chatCompletion(config, [], []),
      /模型消息流未完整结束/,
    );
  });
}

void test('有合法结束原因且连接关闭时保留无DONE的已有兼容行为', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(finalText()));
  assert.equal(
    (await chatCompletion(config, [], [])).content,
    '配置说明已完成',
  );
});

for (const cancelFails of [false, true]) {
  void test(`HTTP失败释放响应流且保留原始HTTP状态（释放${cancelFails ? '失败' : '成功'}）`, async (t) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        if (cancelFails) throw new Error('上游内部正文与连接细节');
      },
    });
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response(body, { status: 503 }),
    );

    await assert.rejects(chatCompletion(config, [], []), {
      message: '模型连接失败（HTTP 503），请稍后重试。',
    });
    assert.equal(cancelled, true);
  });
}
