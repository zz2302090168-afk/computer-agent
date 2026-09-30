import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJevToolChoice,
  selectToolWithJev,
} from '../agent/jev-tool-selector';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';

const tools = ['search_catalog', 'retrieve_knowledge'].map((name) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object' } },
}));
const choice = (key = 't0', confidence = 0.95) => ({
  answers: {
    tool: {
      type: 'choice',
      choice: key,
      confidence,
      probabilities: { t0: 0.99, t1: 0, fallback: 0.01 },
    },
  },
});
void test('Jev工具选择只接受当前候选和有效概率，异常/缺密钥不新增权限', async () => {
  assert.equal(parseJevToolChoice(choice(), tools), 'search_catalog');
  assert.equal(parseJevToolChoice(choice('t0', 0.7), tools), undefined);
  assert.equal(
    parseJevToolChoice(choice('delete_everything'), tools),
    undefined,
  );
  assert.equal(parseJevToolChoice({}, tools), undefined);
  assert.equal((await selectToolWithJev(tools, {})).reason, 'not_needed');
  assert.equal(
    (
      await selectToolWithJev(
        tools,
        {},
        {
          key: 'test',
          request: async () => new Response(null, { status: 401 }),
        },
      )
    ).reason,
    'http_401',
  );
  assert.equal(
    (
      await selectToolWithJev(
        tools,
        {},
        {
          key: 'test',
          request: async () => {
            throw Error('private');
          },
        },
      )
    ).reason,
    'unavailable',
  );
  await assert.rejects(
    selectToolWithJev(tools, {}, { key: 'test', signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
});
const stream = (name?: string, args?: unknown) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: name ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { content: '已查询全部八张显卡' }, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
  );
for (const mode of ['selected', 'fallback', 'wrong_tool'] as const) {
  void test(`Jev选工具调用链 ${mode}：直执行不增加请求，填参只能使用所选工具`, async (t) => {
    const names = [
      'TYPESAFE_API_KEY',
      'JEV_ROUTER_ENABLED',
      'JEV_TOOL_SELECTOR_ENABLED',
    ];
    const saved = names.map((name) => process.env[name]);
    process.env.TYPESAFE_API_KEY = 'test';
    process.env.JEV_ROUTER_ENABLED = 'false';
    process.env.JEV_TOOL_SELECTOR_ENABLED = 'true';
    t.after(() =>
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      }),
    );
    let llm = 0,
      jev = 0,
      offset = 0,
      wrong = false;
    const message = '查询全部显卡，每页2条';
    t.mock.method(
      globalThis,
      'fetch',
      async (url: unknown, options: RequestInit) => {
        assert.equal(typeof options.body, 'string');
        if (typeof options.body !== 'string') throw Error('missing body');
        const body = JSON.parse(options.body);
        if (url === 'https://api.typesafe.ai/v1/systemone') {
          jev++;
          const criteria = body.questions.tool.criteria as Record<
            string,
            string
          >;
          const key = Object.keys(criteria).find((k) =>
            criteria[k].startsWith('search_catalog:'),
          )!;
          return Response.json({
            answers: {
              tool: {
                type: 'choice',
                choice: mode === 'fallback' ? 'fallback' : key,
                confidence: 0.99,
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((k) => [
                    k,
                    k === (mode === 'fallback' ? 'fallback' : key) ? 1 : 0,
                  ]),
                ),
              },
            },
          });
        }
        llm++;
        if (llm === 1)
          return stream('set_request_action', {
            sourceMessageId: 'current',
            nodes: [
              {
                id: 'task1',
                action: 'search_catalog',
                goal: message,
                sourceQuote: message,
                dependsOn: [],
                catalogScope: 'all',
                catalogPageSize: 2,
                invocation: {
                  tool: 'search_catalog',
                  arguments: { category: 'gpu', limit: 2, offset: 0 },
                },
              },
            ],
          });
        if (offset === 6) return stream();
        if (mode !== 'fallback') {
          assert.equal(body.tools.length, 1);
          assert.equal(body.tools[0].function.name, 'search_catalog');
          assert.equal(body.tool_choice, 'required');
        } else assert.ok(body.tools.length > 1);
        if (mode === 'wrong_tool' && !wrong) {
          wrong = true;
          return stream('update_requirements', { budget: 1 });
        }
        offset += 2;
        return stream('search_catalog', { category: 'gpu', limit: 2, offset });
      },
    );
    const f = fixture();
    const result = await runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        task: f.runtime.task,
        currentTaskId: 'task',
        draft: f.runtime.draft,
        result: f.runtime.result,
        messages: [],
      },
      message,
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'test',
      f.context.onTaskChange,
    );
    assert.equal(jev, mode === 'wrong_tool' ? 4 : 3);
    assert.equal(result.executionPlan?.nodes[0].status, 'completed');
    assert.equal(result.executionPlan?.nodes[0].catalogProgress?.ids.length, 8);
    assert.equal(result.draft.budget, 8000);
    assert.equal(f.saved.length, 0);
    assert.equal(
      result.toolSelections.filter((s) => s.reason === 'selected').length,
      mode === 'fallback' ? 0 : jev,
    );
    if (mode === 'wrong_tool')
      assert.ok(
        result.facts.some(
          (f) => f.tool === 'update_requirements' && f.failed && f.rejected,
        ),
      );
  });
}
