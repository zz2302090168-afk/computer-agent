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
        request.headers.get('x-forwarded-proto') ??
        requestUrl.protocol
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
  const value = request.headers
    .get('cookie')
    ?.match(/(?:^|;\s*)pc_session=([a-f0-9-]{36})(?:;|$)/)?.[1];
  return value || crypto.randomUUID();
}
export function json(
  data: unknown,
  status = 200,
  session?: string,
  secure = false,
) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(session
        ? {
            'Set-Cookie': `pc_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure ? '; Secure' : ''}`,
          }
        : {}),
    },
  });
}
