import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { availableTools, runConversation } from '../agent/conversation';
import { executeRegisteredTool } from '../tools/registry';

const sse = (payload: string) =>
  new Response(`data: ${payload}\n\ndata: [DONE]\n\n`, {
    headers: { 'Content-Type': 'text/event-stream' },
  });

const toolCall = (id: string, name: string, args: unknown) =>
  sse(
    JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: 'function',
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
  );

const text = (content: string) =>
  sse(
    JSON.stringify({
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    }),
  );

void test('需求齐全后只开放完整推荐，避免模型在目录查询中空转', () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '需求已保存' };
  assert.deepEqual(
    availableTools(f.runtime, 1).map((tool) => tool.function.name),
    ['recommend_pc'],
  );
  f.runtime.recommendationAttemptKeys = new Set(['已尝试']);
  assert.deepEqual(
    availableTools(f.runtime, 1).map((tool) => tool.function.name),
    ['finish_exploration'],
  );

  f.runtime.recommendationAttemptKeys = undefined;
  f.runtime.candidateSubmissionKeys = new Set(['候选已提交']);
  assert.equal(
    availableTools(f.runtime, 1).some(
      (tool) => tool.function.name === 'retrieve_knowledge',
    ),
    false,
  );
});

void test('模型持续调用工具到轮次耗尽时，仍能返回最终回复而不是整轮失败', async (t) => {
  const f = fixture();
  const choices: string[] = [];
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, options: RequestInit) => {
      const request = JSON.parse(options.body as string) as {
        tool_choice: string;
      };
      choices.push(request.tool_choice);
      const index = calls++;
      // 模拟真实接口：被强制 none 时只能输出文本。
      if (request.tool_choice === 'none')
        return text(
          '本轮目录内没有找到满足该预算的完整配置，需要调整预算或配色。',
        );
      if (index === 0)
        return toolCall(`call-${index}`, 'update_requirements', {
          budget: 8000,
          purpose: '游戏',
        });
      return toolCall(`call-${index}`, 'search_catalog', { category: 'gpu' });
    },
  );

  const result = await runConversation(
    { key: 'test', base: 'https://model.test', model: 'test' },
    {
      draft: {},
      result: null,
      task: { ...f.runtime.task, draft: {}, result: null },
      currentTaskId: 'task',
      messages: [],
    },
    '配一台8000元游戏主机',
    'current',
    f.catalog,
    f.context.reloadCatalog,
    f.context.onUpdate!,
    'session',
    f.context.onTaskChange,
  );

  assert.equal(calls, 16, '应跑满全部轮次');
  assert.equal(choices[15], 'none', '最后一轮必须放开工具调用');
  assert.equal(
    choices.filter((choice) => choice === 'required').length,
    14,
    '探索未完成时中间轮仍应强制继续',
  );
  assert.match(result.messages.at(-1)!.content, /没有找到/);
});

void test('推荐已尝试且无法重试时，允许以观察到的阻碍结束探索', async () => {
  const f = fixture();
  // 复现死锁：recommend_pc 失败后没有诊断，注册表又拒绝重新推荐。
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '候选审核失败' };
  f.runtime.recommendationAttemptKeys = new Set(['已尝试']);

  const result = await executeRegisteredTool(
    'finish_exploration',
    { reason: '候选审核失败，需要用户调整预算或配色' },
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, false, JSON.stringify(result));
  assert.equal(f.runtime.exploration?.status, 'blocked');
});

void test('未启动过推荐时，仍不得用局部空查询代替完整目录诊断', async () => {
  const f = fixture();
  f.runtime.result = null;
  f.runtime.exploration = { status: 'continue', reason: '待生成' };

  const result = await executeRegisteredTool(
    'finish_exploration',
    { reason: '显卡查询为空' },
    f.context,
    f.runtime,
  );
  assert.equal(result.operation.failed, true);
  assert.match('error' in result ? (result.error ?? '') : '', /recommend_pc/);
});
