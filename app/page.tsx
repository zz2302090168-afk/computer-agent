import { connection } from 'next/server';

export default async function Page() {
  // 聊天由共享布局持有，首页仍按请求渲染以读取当前咨询参数。
  await connection();
  return null;
}
