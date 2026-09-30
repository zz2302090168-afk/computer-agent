import assert from 'node:assert/strict';
import { config as loadEnv } from 'dotenv';
import { fixture } from './pc-fixture';
import { runConversation } from '../agent/conversation';

// 真实模型 + 隔离商品夹具；不写业务数据库，也不改变任何环境配置。
loadEnv({ path: '.env.local', quiet: true });
const config = {
  key: process.env.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_NAME,
};
if (!config.key || !config.base || !config.model) {
  console.log('SKIP：没有模型配置');
} else {
  const f = fixture();
  let inFlight = 0,
    peak = 0;
  const reload = async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    try {
      await Promise.resolve();
      return f.catalog;
    } finally {
      inFlight--;
    }
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
      '分别查询显卡目录价格和CPU目录价格。这是两个独立查询，互不依赖，不修改需求或配置。',
      'current',
      f.catalog,
      reload,
      f.context.onUpdate!,
      'isolated-parallel-test',
      f.context.onTaskChange,
      undefined,
      AbortSignal.timeout(60000),
    );
    console.log(
      JSON.stringify({
        modelCalls: output.modelCalls,
        peakCatalogReads: peak,
        batches: output.executionPlan?.parallelBatches,
        nodes: output.executionPlan?.nodes.map(
          ({ id, action, dependsOn, status }) => ({
            id,
            action,
            dependsOn,
            status,
          }),
        ),
        writes: f.saved.length,
      }),
    );
    assert.ok(peak >= 2);
    assert.ok(
      output.executionPlan?.parallelBatches?.some((batch) => batch.length >= 2),
    );
    assert.ok(
      output.executionPlan?.nodes.every((node) => node.status === 'completed'),
    );
    assert.equal(f.saved.length, 0);
    console.log('PASS：真实模型计划触发并行查询');
  } catch {
    console.log('FAIL：并行隔离测试未通过（不输出接口或认证信息）');
    process.exitCode = 1;
  }
}
