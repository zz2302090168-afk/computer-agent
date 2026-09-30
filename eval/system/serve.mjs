// 本机页面验证入口；只读加载既有环境文件，不写入配置。
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
const settings = parse(
  readFileSync(
    process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local',
  ),
);
const child = spawn(
  process.execPath,
  [
    'node_modules/next/dist/bin/next',
    'dev',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3105',
  ],
  { env: { ...settings, ...process.env }, stdio: 'inherit', windowsHide: true },
);
process.on('SIGTERM', () => child.kill());
process.on('SIGINT', () => child.kill());
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
