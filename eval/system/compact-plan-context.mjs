import { traceEvent } from '../../backend/diagnostics/chat-trace.ts';

// 离线候选：仅合并完全相同的配件对象；不按商品ID假定资料相同。
export function compactPrompt(content) {
  const prefix = '\n当前方案：';
  const suffix = '\n当前探索状态：';
  const start = content.indexOf(prefix);
  const end = content.indexOf(suffix, start + prefix.length);
  if (start < 0 || end < 0) return content;
  const original = JSON.parse(content.slice(start + prefix.length, end));
  if (!original?.plans?.length) return content;
  const partsByRef = {};
  const refs = new Map();
  const plans = original.plans.map((plan) => ({
    ...plan,
    parts: plan.parts.map((part) => {
      const key = JSON.stringify(part);
      if (!refs.has(key)) {
        const ref = `p${refs.size}`;
        refs.set(key, ref);
        partsByRef[ref] = part;
      }
      return { partRef: refs.get(key) };
    }),
  }));
  const compact = { ...original, plans, partsByRef };
  const restored = {
    ...compact,
    plans: plans.map((plan) => ({
      ...plan,
      parts: plan.parts.map(({ partRef }) => partsByRef[partRef]),
    })),
  };
  delete restored.partsByRef;
  if (JSON.stringify(restored) !== JSON.stringify(original))
    throw Error('配件上下文压缩无法无损还原');
  const encoded = JSON.stringify(compact);
  if (encoded.length >= JSON.stringify(original).length) return content;
  return (
    content.slice(0, start + prefix.length) +
    encoded +
    '\n各方案parts中的partRef引用partsByRef内的完整配件资料；引用不改变方案顺序或商品身份。' +
    content.slice(end)
  );
}

export function installCompactContext() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const address =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (
      address.endsWith('/chat/completions') &&
      typeof options?.body === 'string'
    ) {
      const body = JSON.parse(options.body);
      const beforeChars = JSON.stringify(body.messages).length;
      body.messages = body.messages.map((message) =>
        message.role === 'system' && typeof message.content === 'string'
          ? { ...message, content: compactPrompt(message.content) }
          : message,
      );
      traceEvent('eval.compact_context', {
        beforeChars,
        afterChars: JSON.stringify(body.messages).length,
      });
      return originalFetch(url, { ...options, body: JSON.stringify(body) });
    }
    return originalFetch(url, options);
  };
}
