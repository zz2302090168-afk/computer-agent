// 仅浏览器性能时间线；刷新即清空，无对话内容、网络上报或持久化。
export function beginChatTiming() {
  const start = performance.now();
  const requestId = crypto.randomUUID();
  let traceId: string | null = null;
  let active = true;
  const seen = new Set<string>();
  const pending = new Set<string>();
  const needsComplete = new Set<string>();
  const record = (stage: string, detail: Record<string, unknown> = {}) => {
    if (!active) return;
    performance.measure('chat.request', {
      start,
      end: performance.now(),
      detail: { requestId, traceId, stage, ...detail },
    });
  };
  return {
    dispose() {
      active = false;
      pending.clear();
    },
    connect(id: string | null) {
      traceId = id;
    },
    receive(type: string, hasAnswer: boolean) {
      for (const stage of [
        'first_event',
        ...(hasAnswer ? ['first_text'] : []),
        ...(type === 'complete' ? ['complete'] : []),
      ]) {
        if (seen.has(stage)) continue;
        seen.add(stage);
        record(`${stage}.received`);
        pending.add(stage);
        if (type === 'complete') needsComplete.add(stage);
      }
    },
    commit(visible: boolean, completeReady: boolean) {
      if (!visible || document.visibilityState !== 'visible') return;
      for (const stage of pending) {
        if (needsComplete.has(stage) && !completeReady) continue;
        record(`${stage}.dom_committed`);
        pending.delete(stage);
      }
    },
    fail(cancelled: boolean) {
      record('end', { status: cancelled ? 'cancelled' : 'failed' });
    },
  };
}
