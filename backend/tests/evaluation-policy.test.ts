import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluationPolicyPrompt,
  withEvaluationPolicy,
} from '../agent/evaluation-policy';
import { runConversation } from '../agent/conversation';
import { fixture } from './pc-fixture';

const policy = (prompt: string) => ({ prompt, experiences: [] });

void test('评测策略只在显式作用域内存在，并发、嵌套与异常不泄漏', async () => {
  assert.equal(evaluationPolicyPrompt(), '');
  const results = await Promise.all(
    ['ALPHA', 'BETA'].map((name) =>
      withEvaluationPolicy(policy(name), async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const own = evaluationPolicyPrompt();
        assert.ok(own.includes(name));
        assert.ok(!own.includes(name === 'ALPHA' ? 'BETA' : 'ALPHA'));
        assert.throws(
          () =>
            withEvaluationPolicy(policy('NESTED'), () => {
              assert.ok(evaluationPolicyPrompt().includes('NESTED'));
              throw new Error('test interruption');
            }),
          /test interruption/,
        );
        assert.equal(evaluationPolicyPrompt(), own);
        return name;
      }),
    ),
  );
  assert.deepEqual(results, ['ALPHA', 'BETA']);
  await assert.rejects(
    withEvaluationPolicy(policy('REJECTED'), async () => {
      await Promise.resolve();
      throw new Error('async interruption');
    }),
    /async interruption/,
  );
  assert.equal(evaluationPolicyPrompt(), '');
});

void test('评测策略固定输入快照并校验有界内容', () => {
  const input = policy('ORIGINAL');
  withEvaluationPolicy(input, () => {
    input.prompt = 'MUTATED';
    assert.ok(evaluationPolicyPrompt().includes('ORIGINAL'));
    assert.ok(!evaluationPolicyPrompt().includes('MUTATED'));
  });
  assert.throws(
    () => withEvaluationPolicy(policy('x'.repeat(12001)), () => {}),
    /prompt/,
  );
  const experience = {
    id: 'same',
    instruction: 'check',
    triggers: ['version'],
  };
  assert.throws(
    () =>
      withEvaluationPolicy(
        { prompt: '', experiences: [experience, experience] },
        () => {},
      ),
    /唯一/,
  );
  assert.equal(evaluationPolicyPrompt(), '');
});

void test('主对话每轮重建提示保留评测建议，退出后生产默认提示完全一致', async (t) => {
  const prompts: string[] = [];
  let calls = 0;
  // 完全模拟模型响应，不读取密钥、不访问模型或业务数据库。
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => {
      assert.ok(typeof options.body === 'string');
      const body = JSON.parse(options.body);
    prompts.push(body.messages[0].content);
    const first = calls++ % 2 === 0;
    const delta = first
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call-${calls}`,
              type: 'function',
              function: {
                name: 'set_request_action',
                arguments: JSON.stringify({
                  action: 'other',
                  nodes: [],
                  sourceMessageId: 'current',
                  otherTopic: 'general',
                }),
              },
            },
          ],
        }
      : { content: '你好。' };
    return new Response(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      {
        headers: { 'Content-Type': 'text/event-stream' },
      },
    );
  });
  const run = () => {
    const f = fixture();
    return runConversation(
      { key: 'test', base: 'https://model.test', model: 'test' },
      {
        draft: f.runtime.draft,
        result: f.runtime.result,
        task: f.runtime.task,
        currentTaskId: f.runtime.task.id,
        messages: [],
      },
      '你好',
      'current',
      f.catalog,
      f.context.reloadCatalog,
      f.context.onUpdate!,
      'evaluation-policy-test',
      f.context.onTaskChange,
    );
  };
  await run();
  const baseline = prompts.splice(0);
  assert.equal(baseline.length, 2);
  await withEvaluationPolicy(
    {
      prompt: 'EVAL_MARKER',
      experiences: [
        {
          id: 'greeting',
          instruction: '先明确用户问题。',
          triggers: ['问候'],
          exceptions: '工具请求按既有规则处理。',
        },
      ],
    },
    run,
  );
  const candidate = prompts.splice(0);
  assert.equal(candidate.length, 2);
  for (let index = 0; index < baseline.length; index++) {
    assert.ok(candidate[index].startsWith(baseline[index]));
    assert.ok(candidate[index].includes('EVAL_MARKER'));
    assert.ok(candidate[index].includes('程序统一审核'));
    assert.ok(candidate[index].includes('工具请求按既有规则处理'));
  }
  await run();
  assert.deepEqual(prompts, baseline);
});
