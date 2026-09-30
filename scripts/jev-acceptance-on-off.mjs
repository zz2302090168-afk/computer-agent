import './register-typescript.mjs';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

if (process.env.JEV_AB_WORKER === '1') {
  if (process.env.JEV_AB_VARIANT === 'off')
    registerHooks({
      load(url, context, next) {
        const result = next(url, context);
        if (!url.endsWith('/backend/services/requirement-acceptance.ts'))
          return result;
        const source = readFileSync(new URL(url), 'utf8');
        const target = 'for (const item of r.requirementItems ?? [])';
        if (source.split(target).length !== 2)
          throw Error('对照注入位置变化，拒绝运行');
        // 仅隔离子进程跳过新增条目验收；保留原预算、型号、颜色、完整性检查。
        // 不伪造任何外部模型响应，不修改磁盘生产源码。
        return {
          ...result,
          source: source.replace(
            target,
            'for (const item of (r.requirementItems ?? []).slice(0, 0))',
          ),
        };
      },
    });
} else {
  const directory = `reports/jev-acceptance-on-off-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await mkdir(directory, { recursive: true });
  const files = [
    'backend/agent/conversation.ts',
    'backend/services/requirement-acceptance.ts',
    'backend/agent/jev-requirements.ts',
    'backend/tests/jev-acceptance-flow-sample.ts',
    'scripts/jev-acceptance-on-off.mjs',
  ];
  const hashes = () =>
    Object.fromEntries(
      files.map((file) => [
        file,
        createHash('sha256').update(readFileSync(file)).digest('hex'),
      ]),
    );
  const initial = hashes();
  const rows = [];
  const scenarios = process.argv.includes('--confirmed')
    ? ['confirmed']
    : ['rules', 'semantic'];
  console.log(directory);
  for (let round = 1; round <= 3; round++)
    for (const [index, scenario] of scenarios.entries()) {
      for (const variant of (round + index) % 2
        ? ['off', 'on']
        : ['on', 'off']) {
        const output = await new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              '--import',
              './scripts/jev-acceptance-on-off.mjs',
              'backend/tests/jev-acceptance-flow-sample.ts',
              scenario,
            ],
            {
              windowsHide: true,
              env: {
                ...process.env,
                JEV_AB_WORKER: '1',
                JEV_AB_VARIANT: variant,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let stdout = '';
          child.stdout.on('data', (data) => {
            stdout += data;
          });
          child.stderr.on('data', () => {}); // 不保存可能包含认证信息的异常原文。
          const timeout = setTimeout(() => child.kill(), 75000);
          child.on('error', () => {
            clearTimeout(timeout);
            resolve({ passed: false, failure: 'process_error' });
          });
          child.on('close', (code) => {
            clearTimeout(timeout);
            try {
              resolve({
                ...JSON.parse(stdout.trim().split(/\r?\n/).at(-1)),
                exitCode: code,
              });
            } catch {
              resolve({
                passed: false,
                failure: 'process_error',
                exitCode: code,
              });
            }
          });
        });
        const row = { round, scenario, variant, ...output };
        rows.push(row);
        await appendFile(
          `${directory}/samples.jsonl`,
          JSON.stringify(row) + '\n',
        );
        console.log(
          JSON.stringify({
            round,
            scenario,
            variant,
            passed: row.passed,
            elapsedMs: row.elapsedMs,
            llm: row.llmCalls,
            jev: row.jevCalls,
          }),
        );
      }
    }
  const median = (values) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? null;
  const summary = Object.fromEntries(
    scenarios.map((scenario) => [
      scenario,
      Object.fromEntries(
        ['off', 'on'].map((variant) => {
          const group = rows.filter(
            (row) => row.scenario === scenario && row.variant === variant,
          );
          return [
            variant,
            {
              samples: group.length,
              passed: group.filter((row) => row.passed).length,
              medianMs: median(
                group.map((row) => row.elapsedMs).filter(Number.isFinite),
              ),
              llmCalls: group.map((row) => row.llmCalls),
              jevCalls: group.map((row) => row.jevCalls),
              jevElapsedMs: group.map((row) => row.jevElapsedMs),
              planIds: group.map((row) => row.planIds),
            },
          ];
        }),
      ),
    ]),
  );
  const changed = JSON.stringify(initial) !== JSON.stringify(hashes());
  await writeFile(
    `${directory}/report.json`,
    JSON.stringify(
      {
        design:
          '同当前代码单变量消融：off不执行新增条目验收/Jev，on当前完整验收；保留两组现有预算型号颜色与适配性、8轮上限。不是历史整个版本回滚。真实主模型+合成目录；轮换AB/BA；总耗时包含规划、工具、验收与最终回答；失败保留。',
        hashes: initial,
        sourceChanged: changed,
        rows,
        summary,
      },
      null,
      2,
    ),
  );
  if (changed) throw Error('源码变化，对照无效');
  console.log(JSON.stringify({ directory, summary }, null, 2));
}
