import { config } from 'dotenv';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const questions = {
  query: {
    type: 'noul',
    instructions: '用户当前是否要求查询商品目录？否定或仅假设不算。',
  },
  save: {
    type: 'noul',
    instructions: '用户当前是否要求保存或修改主机预算？仅讨论预算不算。',
  },
  all: {
    type: 'noul',
    instructions:
      '用户当前是否要求查全符合条件的商品、遍历所有分页？仅前几条、否定查全不算。',
  },
};
const cases = [
  {
    state:
      '查询所有显卡的型号和价格，每次最多2条，继续翻页直到查完，不修改需求。',
    expected: { query: true, save: false, all: true },
  },
  {
    state: '只看前两张显卡，不要查询全部，也不要修改预算。',
    expected: { query: true, save: false, all: false },
  },
  {
    state: '先把主机预算保存为9000元，暂不生成配置；然后查询900元以内的显卡。',
    expected: { query: true, save: true, all: false },
  },
];

// 固定官方域名，不借用主模型密钥，不把密钥发往可配置的第三方端点。
export async function runJevSample(key, model, sample, request = fetch) {
  const started = performance.now();
  const response = await request('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, state: sample.state, questions }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(
      `Jev HTTP ${response.status}（401/403请检查密钥与权限，402请检查额度，429为限流）`,
    );
  }
  const data = await response.json();
  const probabilities = {};
  for (const name of Object.keys(questions)) {
    const answer = data?.answers?.[name];
    if (
      answer?.type !== 'noul' ||
      typeof answer.noul !== 'number' ||
      !Number.isFinite(answer.noul) ||
      answer.noul < 0 ||
      answer.noul > 1
    )
      throw Error('Jev响应缺少有效的判断概率');
    probabilities[name] = answer.noul;
  }
  const passed = Object.entries(sample.expected).every(
    ([name, expected]) => probabilities[name] >= 0.5 === expected,
  );
  const token = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    passed,
    probabilities,
    elapsedMs: Math.round(performance.now() - started),
    inputTokens: token(data?.usage?.input_tokens),
    outputTokens: token(data?.usage?.output_tokens),
  };
}

async function main() {
  config({ path: '.env.local', quiet: true });
  const key = process.env.TYPESAFE_API_KEY?.trim();
  const model = process.env.TYPESAFE_MODEL?.trim() || 'jev-latest';
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.some((arg) => arg !== '--check'))
    throw Error('仅支持 pnpm test:jev 或 pnpm test:jev --check');
  if (!key)
    throw Error(
      '缺少 TYPESAFE_API_KEY，请在本地 .env.local 或进程环境中配置；不要把密钥发到聊天里。',
    );
  if (args.includes('--check')) {
    console.log('Jev密钥已配置（未显示、未联网）；模型配置已读取。');
    return;
  }
  console.log(
    '仅发送3条固定测试句，不发送数据库、历史对话或项目源码；不改变聊天主流程。',
  );
  for (const [index, sample] of cases.entries()) {
    const result = await runJevSample(key, model, sample);
    console.log(JSON.stringify({ sample: index + 1, ...result }));
    if (!result.passed) process.exitCode = 1;
  }
  console.log(
    '0.5阈值仅用于冒烟检查，不作为生产路由阈值；3条测试不能证明整体准确性或性能收益。',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // 网络错误及第三方响应可能包含敏感信息，禁止原样输出。
    const message = error instanceof Error ? error.message : '';
    console.error(
      message.startsWith('缺少 TYPESAFE_API_KEY') ||
        message.startsWith('仅支持 pnpm') ||
        message.startsWith('Jev HTTP ') ||
        message === 'Jev响应缺少有效的判断概率'
        ? message
        : 'Jev测试失败（网络、超时或响应解析异常），未输出原始错误。',
    );
    process.exitCode = 1;
  });
}
