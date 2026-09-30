import test from 'node:test';
import assert from 'node:assert/strict';
import { runJevSample } from './test-jev.mjs';

const sample = {
  state: '只看前两条，不改预算',
  expected: { query: true, save: false, all: false },
};
const data = {
  answers: {
    query: { type: 'noul', noul: 0.9 },
    save: { type: 'noul', noul: 0.1 },
    all: { type: 'noul', noul: 0.1 },
  },
};
void test('Jev请求使用独立密钥及固定端点，缺失usage不计零', async () => {
  const result = await runJevSample(
    'test-only',
    'jev-latest',
    sample,
    async (url, options) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(options.headers.Authorization, 'Bearer test-only');
      assert.equal(options.redirect, 'error');
      assert.equal(JSON.parse(options.body).state, sample.state);
      return Response.json(data);
    },
  );
  assert.equal(result.passed, true);
  assert.equal(result.inputTokens, null);
});
void test('Jev语义错误记为未通过，缺字段或越界概率拒绝', async () => {
  const wrong = structuredClone(data);
  wrong.answers.all.noul = 0.9;
  assert.equal(
    (
      await runJevSample('test', 'jev-latest', sample, async () =>
        Response.json(wrong),
      )
    ).passed,
    false,
  );
  wrong.answers.all.noul = 2;
  await assert.rejects(
    runJevSample('test', 'jev-latest', sample, async () =>
      Response.json(wrong),
    ),
    /有效/,
  );
  await assert.rejects(
    runJevSample('test', 'jev-latest', sample, async () => Response.json({})),
    /有效/,
  );
});
void test('Jev服务错误不输出原始响应', async () => {
  await assert.rejects(
    runJevSample(
      'test',
      'jev-latest',
      sample,
      async () => new Response('sensitive-response', { status: 401 }),
    ),
    (error) =>
      error.message.includes('401') &&
      !error.message.includes('sensitive-response'),
  );
});
