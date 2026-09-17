import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

type TraceContext = {
  record: (event: string, data: unknown) => void;
  parentId?: string;
};
const shared = globalThis as typeof globalThis & {
  chatTraceContext?: AsyncLocalStorage<TraceContext>;
};
const context = (shared.chatTraceContext ??=
  new AsyncLocalStorage<TraceContext>());

function serialize(value: unknown) {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, value]) =>
        /key|token|secret|password|database_url/i.test(key) &&
        value &&
        value.length >= 8,
    )
    .map(([, value]) => value!);
  return JSON.stringify(value, (key, item: unknown) => {
    if (
      /^(authorization|cookie|set-cookie|key|api[_-]?key|.*token|.*secret|.*password|database_url)$/i.test(
        key,
      )
    )
      return '[REDACTED]';
    if (item instanceof Error)
      return { name: item.name, message: item.message, stack: item.stack };
    if (typeof item !== 'string') return item;
    let result = item
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
      .replace(
        /(\b[a-z][a-z0-9+.-]{0,19}:\/\/)[^\s/@]+:[^\s/@]+@/gi,
        '$1[REDACTED]@',
      );
    for (const secret of secrets)
      result = result.split(secret).join('[REDACTED]');
    return result;
  });
}

// 独立排查记录，不作为页面会话的数据源，也不向浏览器提供读取接口。
export function createChatTrace(
  initial: unknown,
  directory = join(process.cwd(), 'logs', 'chat'),
) {
  const traceId = crypto.randomUUID();
  const origin = performance.now();
  const file = join(directory, `${Date.now()}-${traceId}.jsonl`);
  let bytes = 0;
  let truncated = false;
  let disabled = false;
  const maxBytes = 8 * 1024 * 1024;
  const record = (event: string, data: unknown) => {
    if (disabled || (truncated && event !== 'end')) return;
    try {
      let line =
        serialize({
          time: new Date().toISOString(),
          traceId,
          elapsedMs: performance.now() - origin,
          event,
          data,
        }) + '\n';
      if (
        bytes + Buffer.byteLength(line) > maxBytes - 1024 &&
        event !== 'end'
      ) {
        truncated = true;
        line =
          serialize({
            time: new Date().toISOString(),
            traceId,
            elapsedMs: performance.now() - origin,
            event: 'truncated',
            data: '记录达到 8 MiB 上限',
          }) + '\n';
      }
      if (event === 'end' && bytes + Buffer.byteLength(line) > maxBytes) {
        line =
          serialize({
            time: new Date().toISOString(),
            traceId,
            event: 'end',
            data: { truncated: true },
          }) + '\n';
      }
      if (bytes + Buffer.byteLength(line) > maxBytes) return;
      appendFileSync(file, line, { mode: 0o600 });
      bytes += Buffer.byteLength(line);
    } catch {
      disabled = true;
      console.error('[chat-trace] 后端诊断记录写入失败');
    }
  };
  try {
    mkdirSync(directory, { recursive: true });
    const files = readdirSync(directory)
      .filter((name) => /^\d{13}-[a-f0-9-]{36}\.jsonl$/.test(name))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - 99)))
      unlinkSync(join(directory, name));
  } catch {
    disabled = true;
    console.error('[chat-trace] 后端诊断目录不可用');
  }
  record('start', initial);
  return {
    file,
    traceId,
    record,
    run: <T>(work: () => T): T => context.run({ record }, work),
  };
}

export async function traceOperation<T>(
  kind: string,
  input: unknown,
  work: () => Promise<T>,
  recordResult = true,
): Promise<T> {
  const current = context.getStore();
  if (!current) return work();
  const callId = crypto.randomUUID();
  const start = performance.now();
  current.record(`${kind}.start`, {
    callId,
    parentId: current.parentId,
    input,
  });
  return context.run({ record: current.record, parentId: callId }, async () => {
    try {
      const result = await work();
      current.record(`${kind}.result`, {
        callId,
        durationMs: performance.now() - start,
        status: 'success',
        ...(recordResult ? { result } : {}),
      });
      return result;
    } catch (error) {
      current.record(`${kind}.error`, {
        callId,
        durationMs: performance.now() - start,
        status: operationStatus(error),
        error,
      });
      throw error;
    }
  });
}

function operationStatus(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
    ? 'cancelled'
    : error instanceof Error && error.name === 'TimeoutError'
      ? 'timeout'
      : 'failed';
}

export function traceEvent(event: string, data: unknown) {
  const current = context.getStore();
  current?.record(event, { parentId: current.parentId, data });
}

// 同步审核/排序保持同步调用约定，不增加调度或重试。
export function traceSync<T>(kind: string, input: unknown, work: () => T): T {
  const current = context.getStore();
  if (!current) return work();
  const callId = crypto.randomUUID(),
    start = performance.now();
  current.record(`${kind}.start`, {
    callId,
    parentId: current.parentId,
    input,
  });
  return context.run({ record: current.record, parentId: callId }, () => {
    try {
      const result = work();
      current.record(`${kind}.result`, {
        callId,
        durationMs: performance.now() - start,
        status: 'success',
      });
      return result;
    } catch (error) {
      current.record(`${kind}.error`, {
        callId,
        durationMs: performance.now() - start,
        status: operationStatus(error),
        error,
      });
      throw error;
    }
  });
}
