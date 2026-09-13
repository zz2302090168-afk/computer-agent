export function assertSameOrigin(request: Request) {
  const originValue = request.headers.get('origin');
  if (!originValue) return;
  try {
    const requestUrl = new URL(request.url),
      origin = new URL(originValue),
      host = (
        request.headers.get('x-forwarded-host') ??
        request.headers.get('host') ??
        requestUrl.host
      )
        .split(',')[0]
        .trim()
        .toLowerCase(),
      protocol = (
        request.headers.get('x-forwarded-proto') ?? requestUrl.protocol
      )
        .split(',')[0]
        .trim()
        .replace(/:$/, '')
        .toLowerCase();
    if (
      origin.host.toLowerCase() === host &&
      origin.protocol.toLowerCase() === `${protocol}:`
    )
      return;
  } catch {}
  throw Error('拒绝跨站写入请求');
}
export async function readJson(request: Request) {
  assertSameOrigin(request);
  const text = await request.text();
  if (text.length > 16000) throw Error('请求过长');
  return JSON.parse(text);
}
export function sessionId(request: Request) {
  const value = request.headers.get('x-page-session');
  if (
    !value ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw Error('当前页面会话无效，请重新开始对话');
  return value;
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
