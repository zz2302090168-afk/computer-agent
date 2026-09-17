import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';
import { executeRegisteredTool } from '../tools/registry';

void test('目录答复只使用数据库证据，多次查询保留各商品且不泄露模型猜测', async (t) => {
  const f = fixture();
  const memory = f.catalog.parts.find((p) => p.category === 'memory')!;
  memory.specs.inferredFields = ['height'];
  let calls = 0;
  const streamed: string[] = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const query = [
      {
        name: 'set_request_action',
        args: { action: 'search_catalog', sourceMessageId: 'current' },
      },
      { name: 'search_catalog', args: { category: 'memory' } },
      { name: 'search_catalog', args: { category: 'cpu' } },
    ][calls++];
    const delta = query
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${calls}`,
              type: 'function',
              function: {
                name: query.name,
                arguments: JSON.stringify(query.args),
              },
            },
          ],
        }
      : { content: '内存频率6000MHz，免费包邮，兼容性全部通过。' };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: query ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  const result = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: f.runtime.draft,
      result: f.runtime.result,
      task: f.runtime.task,
      currentTaskId: 'task',
      messages: [],
    },
    '只查CPU和内存目录，不修改配置。',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
    undefined,
    undefined,
    undefined,
    undefined,
    (text) => streamed.push(text),
  );
  const reply = result.messages.at(-1)!.content;
  assert.match(reply, /测试内存/);
  assert.match(reply, /测试CPU/);
  assert.match(reply, /高度（mm）：30（推定或未核实，待确认）/);
  assert.ok(!reply.includes('6000MHz'));
  assert.ok(!reply.includes('包邮'));
  assert.ok(!reply.includes('兼容性全部通过'));
  assert.ok(streamed.every((text) => !text.includes('6000MHz')));
  assert.equal(f.saved.length, 0);
});

void test('无匹配仅描述本次查询；替换中的目录查询不覆盖替换最终答复', async () => {
  const f = fixture();
  f.runtime.requestAction = 'search_catalog';
  const empty = await executeRegisteredTool(
    'search_catalog',
    { category: 'gpu', brand: '不存在的品牌' },
    f.context,
    f.runtime,
  );
  assert.ok(
    'data' in empty &&
      empty.data &&
      typeof empty.data === 'object' &&
      'displayReply' in empty.data,
  );
  assert.match(String(empty.data.displayReply), /本页未找到匹配商品/);
  f.runtime.requestAction = 'find_replacements';
  const lookup = await executeRegisteredTool(
    'search_catalog',
    { category: 'gpu' },
    f.context,
    f.runtime,
  );
  assert.ok('data' in lookup && lookup.data && typeof lookup.data === 'object');
  assert.ok(!('displayReply' in lookup.data));
});
