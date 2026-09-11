// Decode incrementally: UTF-8 characters and protocol lines may cross network chunks.
export async function* readLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        yield pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
      }
      if (done) break;
    }
    if (pending) yield pending.replace(/\r$/, '');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
