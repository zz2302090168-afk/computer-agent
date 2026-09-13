import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runConversation } from '../agent/conversation';
import { labels, type PcTask } from '../domain/types';
import { fixture } from './pc-fixture';

// 仅显式运行：真实模型、隔离目录、内存保存，不加入默认测试入口。
const settings: Record<string, string> = {};
if (existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const match = line.match(
      /^\s*(MODEL_(?:API_KEY|BASE_URL|NAME))\s*=\s*(.*?)\s*$/,
    );
    if (match) settings[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const config = {
  key: process.env.MODEL_API_KEY ?? settings.MODEL_API_KEY,
  base: process.env.MODEL_BASE_URL ?? settings.MODEL_BASE_URL,
  model: process.env.MODEL_NAME ?? settings.MODEL_NAME,
};
// 只清除本次独立测试进程的连接变量；即使模型误选任务工具也不能连接数据库。
delete process.env.DATABASE_URL;

if (!config.key || !config.base || !config.model) {
  console.log('SKIP: 未配置模型，本次未执行空任务真实模型检查。');
} else {
  const cases = [
    {
      name: 'N01 空任务直接配机',
      message: '预算8000元，玩游戏，请直接配好主机',
      generate: true,
    },
    {
      name: 'N02 空任务仅保存需求',
      message: '预算8000元，玩游戏，先保存需求，暂时不要生成配置',
      generate: false,
    },
  ];
  let failed = 0;
  for (const item of cases) {
    const f = fixture();
    let current: PcTask = {
      ...f.runtime.task,
      draft: {},
      result: null,
    };
    const saved: { type: string; task: PcTask }[] = [];
    console.log(`RUN ${item.name}`);
    try {
      const output = await runConversation(
        config,
        {
          task: current,
          currentTaskId: current.id,
          draft: {},
          result: null,
          messages: [],
          tasks: [],
        },
        item.message,
        'current',
        f.catalog,
        async () => f.catalog,
        async (type, draft, result) => {
          current = {
            ...current,
            draft,
            result,
            version: current.version + 1,
          };
          saved.push({ type, task: structuredClone(current) });
          return current.version;
        },
        'session',
        async () => {
          throw Error('空任务入口测试不得切换或创建其他任务');
        },
        undefined,
        AbortSignal.timeout(60000),
      );
      const successful = output.facts.filter((fact) => !fact.failed);
      assert.ok(
        successful.some((fact) => fact.tool === 'update_requirements'),
        '未实际保存用户需求',
      );
      assert.equal(output.draft.budget, 8000, '预算没有记录为8000元');
      assert.equal(output.draft.purpose, '游戏', '游戏用途没有实际记录');
      assert.ok(
        saved.some(
          ({ type, task }) =>
            type === 'requirements' &&
            task.draft.budget === 8000 &&
            task.draft.purpose === '游戏',
        ),
        '缺少需求持久化事实',
      );
      const plans = output.result?.plans ?? [];
      if (item.generate) {
        assert.ok(
          successful.some((fact) => fact.tool === 'recommend_pc'),
          '未实际执行推荐工具',
        );
        assert.ok(plans.length > 0, '没有交付完整方案');
        for (const plan of plans) {
          assert.equal(plan.parts.length, 8, '方案没有覆盖八类配件');
          assert.deepEqual(
            new Set(plan.parts.map((part) => part.category)),
            new Set(Object.keys(labels)),
          );
          assert.ok(
            plan.parts.every((part) =>
              f.catalog.parts.some((item) => item.id === part.id),
            ),
            '方案包含隔离目录之外的商品',
          );
          assert.equal(
            plan.deliveryAudit?.status,
            'passed',
            '方案未通过交付审核',
          );
          assert.notEqual(
            plan.validation.status,
            'fail',
            '方案存在已知兼容冲突',
          );
          assert.equal(plan.budget.confirmable, true, '方案预算不可确认');
        }
        assert.ok(
          saved.some(
            ({ type, task }) => type === 'plan' && task.result?.plans.length,
          ),
          '缺少审核后方案保存事实',
        );
      } else {
        assert.ok(
          output.facts.every(
            (fact) =>
              !['recommend_pc', 'assemble_build', 'select_prebuilt'].includes(
                fact.tool,
              ),
          ),
          '暂不生成时调用了配置生成工具',
        );
        assert.equal(plans.length, 0, '暂不生成时出现方案');
        assert.ok(
          saved.every(({ task }) => !task.result?.plans.length),
          '暂不生成时保存了方案',
        );
      }
      console.log(
        `PASS ${item.name}：成功工具=${successful.map((fact) => fact.tool).join(',')}；方案=${plans.length}；保存=${saved.length}`,
      );
    } catch (cause) {
      failed++;
      console.log(
        `FAIL ${item.name}：${cause instanceof Error ? cause.message.split('\n')[0] : '入口检查失败'}`,
      );
    }
  }
  console.log(
    `空任务真实模型入口：${cases.length - failed}/${cases.length} 通过。`,
  );
  if (failed) process.exitCode = 1;
}
