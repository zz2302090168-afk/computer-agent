import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';

// 显式运行真实模型，隔离商品夹具与会话；不写业务数据库。
loadEnv({ path: '.env.local', quiet: true });
const config = {
  key: process.env.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME,
};
if (!config.key || !config.base || !config.model) {
  console.log('SKIP：没有模型配置');
} else {
  for (const message of [
    '只查询目录中900元以内的显卡，不要修改任何需求或配置。',
    '帮我查询一下目录里有哪些显卡以及价格；另外把我的主机预算改为9000元，只记录需求，这轮先不要生成配置。这两个要求都请处理。',
    '先把主机预算记录为9000元，暂不生成配置；然后查询价格不超过新预算十分之一的显卡。',
  ]) {
    const f = fixture();
    const originalFetch = globalThis.fetch;
    let modelCalls = 0;
    globalThis.fetch = (...args) => {
      modelCalls++;
      return originalFetch(...args);
    };
    try {
      const output = await runConversation(
        config,
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
        'isolated-plan-test',
        f.context.onTaskChange,
        undefined,
        AbortSignal.timeout(60000),
      );
      console.log(
        JSON.stringify(
          {
            message,
            modelCalls,
            budget: output.draft.budget,
            plan: output.executionPlan,
            tools: output.facts.map((f) => ({
              tool: f.tool,
              failed: f.failed,
              error: f.error,
              arguments: f.arguments,
            })),
            answer: output.messages.at(-1)?.content,
          },
          null,
          2,
        ),
      );
      const simple = message.startsWith('只查询');
      assert.equal(output.draft.budget, simple ? 8000 : 9000);
      assert.ok(
        output.executionPlan &&
          output.executionPlan.nodes.length === (simple ? 1 : 2),
      );
      assert.ok(
        output.executionPlan.nodes.every((n) => n.status === 'completed'),
      );
      for (const tool of simple
        ? ['search_catalog']
        : ['search_catalog', 'update_requirements'])
        assert.ok(output.facts.some((f) => f.tool === tool && !f.failed));
      if (simple) {
        assert.equal(modelCalls, 2);
        assert.equal(output.executionPlan.nodes[0].directAttempted, true);
        assert.equal(f.saved.length, 0);
      }
      assert.ok(
        !output.facts.some((f) =>
          ['recommend_pc', 'select_plan', 'replace_parts'].includes(f.tool),
        ),
      );
      if (message.startsWith('先把')) {
        const save = output.executionPlan.nodes.find(
          (n) => n.action === 'save_requirements',
        );
        const query = output.executionPlan.nodes.find(
          (n) => n.action === 'search_catalog',
        );
        assert.ok(save && query?.dependsOn.includes(save.id));
        assert.ok(
          output.facts.some(
            (fact) =>
              fact.tool === 'search_catalog' &&
              !fact.failed &&
              (fact.arguments as { maxPrice?: number })?.maxPrice === 900,
          ),
        );
      }
      console.log('PASS：真实模型多意图执行');
    } catch {
      console.log('FAIL：真实模型多意图测试未通过（不输出接口或认证信息）');
      process.exitCode = 1;
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
}
