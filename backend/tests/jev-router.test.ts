import test from 'node:test';
import assert from 'node:assert/strict';
import { jevDecisionNodes, tryJevRoute } from '../agent/jev-router';
import { runConversation } from '../agent/conversation';
import { fixture } from './pc-fixture';

const accepted = {
  answers: {
    eligible: { type: 'noul', noul: 0.99 },
    route: {
      type: 'choice',
      choice: 'both',
      confidence: 0.95,
      probabilities: { gpu: 0.005, cpu: 0.005, both: 0.98, fallback: 0.01 },
    },
  },
};
void test('Jev只允许固定只读模板：概率、置信度、类别或结构不可信则回退', () => {
  const nodes = jevDecisionNodes(accepted, '查显卡和CPU');
  assert.deepEqual(
    nodes?.map((n) => n.invocation),
    [
      { tool: 'search_catalog', arguments: { category: 'gpu' } },
      { tool: 'search_catalog', arguments: { category: 'cpu' } },
    ],
  );
  for (const patch of [
    { choice: 'update_requirements' },
    { confidence: 0.79 },
    { probabilities: { both: 1 } },
    { probabilities: { gpu: 1, cpu: 1, both: 1, fallback: 1 } },
  ]) {
    assert.equal(
      jevDecisionNodes(
        {
          answers: {
            ...accepted.answers,
            route: { ...accepted.answers.route, ...patch },
          },
        },
        'test',
      ),
      undefined,
    );
  }
  assert.equal(
    jevDecisionNodes(
      {
        answers: {
          ...accepted.answers,
          eligible: { type: 'noul', noul: 0.89 },
        },
      },
      'test',
    ),
    undefined,
  );
  assert.equal(jevDecisionNodes({}, 'test'), undefined);
});
void test('Jev缺密钥、HTTP错误、网络错误和畸形响应回退；取消不吞掉', async () => {
  assert.equal((await tryJevRoute('test')).reason, 'missing_key');
  assert.equal(
    (
      await tryJevRoute('test', {
        key: 'test',
        request: async () => new Response('private', { status: 401 }),
      })
    ).reason,
    'http_401',
  );
  assert.equal(
    (
      await tryJevRoute('test', {
        key: 'test',
        request: async () => {
          throw Error('private');
        },
      })
    ).reason,
    'unavailable',
  );
  assert.equal(
    (
      await tryJevRoute('test', {
        key: 'test',
        request: async () => Response.json({}),
      })
    ).reason,
    'unsupported_or_uncertain',
  );
  await assert.rejects(
    tryJevRoute('test', { key: 'test', signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
});

function stream(tool?: { name: string; arguments: unknown }) {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: 'call-test',
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          },
        ],
      }
    : { content: '已依据目录返回查询结果。' };
  return new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
}
for (const mode of ['accepted', 'fallback', 'history', 'off'] as const) {
  void test(`Jev完整调用链 ${mode} 保留门禁且无写入`, async (t) => {
    const oldKey = process.env.TYPESAFE_API_KEY,
      oldEnabled = process.env.JEV_ROUTER_ENABLED;
    process.env.TYPESAFE_API_KEY = 'test';
    process.env.JEV_ROUTER_ENABLED = mode === 'off' ? 'false' : 'true';
    t.after(() => {
      if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = oldKey;
      if (oldEnabled === undefined) delete process.env.JEV_ROUTER_ENABLED;
      else process.env.JEV_ROUTER_ENABLED = oldEnabled;
    });
    let jev = 0,
      llm = 0;
    const message = '查询显卡和CPU目录价格';
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (url === 'https://api.typesafe.ai/v1/systemone') {
        jev++;
        return Response.json(mode === 'fallback' ? {} : accepted);
      }
      llm++;
      if (mode !== 'accepted' && llm === 1)
        return stream({
          name: 'set_request_action',
          arguments: {
            sourceMessageId: 'current',
            nodes: jevDecisionNodes(accepted, message)?.map(
              ({ status: _status, ...node }) => node,
            ),
          },
        });
      return stream();
    });
    const f = fixture();
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        task: f.runtime.task,
        currentTaskId: 'task',
        draft: f.runtime.draft,
        result: f.runtime.result,
        messages: mode === 'history' ? [{ role: 'user', content: '你好' }] : [],
      },
      message,
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'test',
      f.context.onTaskChange,
    );
    assert.equal(jev, ['history', 'off'].includes(mode) ? 0 : 1);
    assert.equal(llm, mode === 'accepted' ? 1 : 2);
    assert.ok(
      result.executionPlan?.nodes.every((n) => n.status === 'completed'),
    );
    assert.equal(
      result.facts.filter((f) => f.tool === 'search_catalog' && !f.failed)
        .length,
      2,
    );
    assert.equal(f.saved.length, 0);
  });
}
