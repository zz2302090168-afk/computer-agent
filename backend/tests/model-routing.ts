import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fixture } from './pc-fixture';
import { runConversation, type ChatState } from '../agent/conversation';
import { selectPlan } from '../services/select-plan';

// 显式运行的真实模型路由检查；只使用隔离夹具，不连接任务数据库、不发送生产请求。
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
if (!config.key || !config.base || !config.model) {
  console.log('SKIP: 未配置模型，本次未执行真实模型路由检查。');
} else {
  const cases = [
    {
      name: 'R01 选定不等于确认',
      message: '先用均衡那套继续聊，不是最终确认。',
      expected: 'select_plan',
      selected: false,
    },
    {
      name: 'R02 明确确认指定方案',
      message: '我确认高价方案，就这套主机。',
      expected: 'select_plan',
      selected: false,
    },
    {
      name: 'R03 替换预览不执行',
      message: '其他配件不动，看看当前方案显卡能换哪些便宜的选项，先不要改。',
      expected: 'find_replacements',
      selected: true,
    },
    {
      name: 'R04 只解释选择原因',
      message: '均衡方案为什么选这张显卡？只说明理由。',
      expected: 'explain_selection',
      selected: false,
    },
    {
      name: 'R05 多套指代不明',
      message: '给这套换个显卡。',
      expected: undefined,
      selected: false,
    },
    {
      name: 'R06 明确局部替换',
      message: '只把当前方案显卡换成目录中的gpu-cheaper，其余配件别动。',
      expected: 'replace_parts',
      selected: true,
    },
  ];
  let failed = 0;
  for (const item of process.argv.includes('--multi') ? [] : cases) {
    const f = fixture();
    let current = item.selected
      ? selectPlan(f.runtime.task, 'plan-1', f.catalog, { source: 'ui' })
      : structuredClone(f.runtime.task);
    const before = structuredClone({
      draft: current.draft,
      result: current.result,
    });
    try {
      const output = await runConversation(
        config,
        {
          task: current,
          draft: current.draft,
          result: current.result,
          messages: [],
          currentTaskId: current.id,
          tasks: [],
        },
        item.message,
        'current',
        f.catalog,
        async () => f.catalog,
        async (_type, draft, result) => {
          current = { ...current, draft, result, version: current.version + 1 };
          return current.version;
        },
        'session',
        async () => {
          throw Error('本用例不得操作其他任务');
        },
        undefined,
        AbortSignal.timeout(60000),
      );
      if (item.expected)
        assert.ok(
          output.facts.some(
            (fact) => fact.tool === item.expected && !fact.failed,
          ),
          '未成功调用预期工具',
        );
      if (['R03', 'R04', 'R05'].some((prefix) => item.name.startsWith(prefix)))
        assert.deepEqual(
          { draft: output.draft, result: output.result },
          before,
          '只读或指代未明时不得修改配置',
        );
      if (item.name.startsWith('R01')) {
        assert.equal(output.result?.selection?.planId, 'plan-1');
        assert.equal(output.result?.selection?.status, 'selected');
      }
      if (item.name.startsWith('R02')) {
        assert.equal(output.result?.selection?.planId, 'plan-2');
        assert.equal(output.result?.selection?.status, 'confirmed');
      }
      if (item.name.startsWith('R05'))
        assert.match(
          output.messages.at(-1)?.content ?? '',
          /哪|选择|低价|均衡|高价/,
        );
      if (item.name.startsWith('R06')) {
        const plan = output.result!.plans[0];
        assert.equal(
          plan.parts.find((part) => part.category === 'gpu')!.id,
          'gpu-cheaper',
        );
        for (const part of plan.parts.filter((part) => part.category !== 'gpu'))
          assert.equal(part.id, part.category);
      }
      console.log(`PASS ${item.name}`);
    } catch (cause) {
      failed++;
      // 不打印配置或模型原始响应，避免泄露密钥与服务信息。
      console.log(
        `FAIL ${item.name}: ${cause instanceof Error ? cause.message.split('\n')[0] : '路由检查失败'}`,
      );
    }
  }
  if (!process.argv.includes('--multi'))
    console.log(
      `模型路由检查：${cases.length - failed}/${cases.length} 通过。`,
    );
  // 真正连续轮次：回传完整历史、最新任务与配置；不注入工具调用脚本。
  const f = fixture();
  const gpu = f.catalog.parts.find((part) => part.id === 'gpu-more-power')!;
  gpu.name = '星云显卡A';
  gpu.price = 980;
  f.catalog.parts.push({
    ...structuredClone(gpu),
    id: 'gpu-more-power-b',
    name: '星云显卡B',
    price: 1020,
  });
  let state: ChatState = {
    task: structuredClone(f.runtime.task),
    currentTaskId: 'task',
    draft: structuredClone(f.runtime.draft),
    result: structuredClone(f.runtime.result),
    messages: [],
    tasks: [],
  };
  const turns = [
    '先用均衡那套继续聊，不是最终确认。',
    '显卡只考虑商品名称包含“星云”的型号，看看能不能换。其他配件先不动，只查询，不要改。',
    '那电源也可以一起换，其他六件保持不动，预算还是原来的。先查询两件联动组合，按显卡价格从低到高给我两个选项，先别替换。',
    '用你刚才列出的第二组替换，只换那两件，不是最终确认。',
    '只是替换，还没最终确认。解释一下现在这两件是否匹配，不要再改配置。',
    '现在确认当前这套主机。',
  ];
  let passedTurns = 0,
    lastReply = '',
    lastFacts: unknown;
  try {
    for (const [index, message] of turns.entries()) {
      const before = structuredClone({
        draft: state.draft,
        result: state.result,
      });
      const output = await runConversation(
        config,
        state,
        message,
        `multi-${index}`,
        f.catalog,
        async () => f.catalog,
        async (_type, draft, result) => {
          state.task = {
            ...state.task!,
            draft,
            result,
            version: state.task!.version + 1,
          };
          return state.task.version;
        },
        'session',
        async () => {
          throw Error('多轮测试不得切换任务');
        },
        undefined,
        AbortSignal.timeout(60000),
      );
      lastReply = output.messages.at(-1)?.content ?? '';
      lastFacts = output.facts;
      const success = (tool: string) =>
        assert.ok(
          output.facts.some((fact) => fact.tool === tool && !fact.failed),
          `第${index + 1}轮未成功调用${tool}`,
        );
      assert.equal(output.messages.length, (index + 1) * 2, '历史未连续保留');
      assert.equal(output.draft.budget, 8000);
      assert.equal(output.draft.budgetTolerance, 50);
      if ([1, 2, 4].includes(index))
        assert.deepEqual(
          { draft: output.draft, result: output.result },
          before,
          '预览或解释不得改状态',
        );
      if (index === 0) {
        success('select_plan');
        assert.equal(output.result?.selection?.planId, 'plan-1');
      }
      if (index === 1 || index === 2) success('find_replacements');
      if (index === 1 || index === 2)
        assert.ok(
          output.messages
            .at(-1)
            ?.replacementQueries?.some((entry) => entry.role === 'tool'),
          '查询事实未随历史保存',
        );
      if (index === 2) {
        const reply = output.messages.at(-1)!.content;
        assert.match(reply, /星云显卡A/);
        assert.match(reply, /星云显卡B/);
        assert.ok(
          reply.indexOf('星云显卡A') < reply.indexOf('星云显卡B'),
          '候选顺序不正确',
        );
      }
      if (index >= 3) {
        const plan = output.result!.plans[0];
        assert.equal(
          plan.parts.find((part) => part.category === 'gpu')!.id,
          'gpu-more-power-b',
          '第二组跨轮指代错误',
        );
        assert.equal(
          plan.parts.find((part) => part.category === 'psu')!.id,
          'psu-1000',
        );
        for (const part of plan.parts.filter(
          (part) => !['gpu', 'psu'].includes(part.category),
        ))
          assert.equal(part.id, part.category);
        assert.equal(plan.total, 8020);
      }
      if (index === 3) success('replace_parts');
      if (index < 5)
        assert.notEqual(
          output.result?.selection?.status,
          'confirmed',
          '提前确认',
        );
      else {
        success('select_plan');
        assert.equal(output.result?.selection?.status, 'confirmed');
      }
      state = {
        ...state,
        draft: output.draft,
        result: output.result,
        messages: JSON.parse(JSON.stringify(output.messages)),
        task: { ...state.task!, draft: output.draft, result: output.result },
      };
      passedTurns++;
      console.log(`PASS M01 第${index + 1}轮`);
    }
  } catch (cause) {
    failed++;
    console.log(`隔离测试失败轮回复：${lastReply}`);
    console.log(`失败轮工具状态：${JSON.stringify(lastFacts)}`);
    console.log(
      `FAIL M01 第${passedTurns + 1}轮: ${cause instanceof Error ? cause.message.split('\n')[0] : '连续对话失败'}`,
    );
  }
  console.log(`连续多轮对话：${passedTurns}/${turns.length}轮通过。`);
  if (failed) process.exitCode = 1;
}
