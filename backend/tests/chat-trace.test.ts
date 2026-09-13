import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatTrace, traceOperation } from '../diagnostics/chat-trace';

const directory = mkdtempSync(join(tmpdir(), 'chat-trace-'));
const previousSecret = process.env.CHAT_TRACE_TEST_SECRET;
try {
  process.env.CHAT_TRACE_TEST_SECRET = 'test-secret-123456';
  const first = createChatTrace(
    { message: '测试消息', apiKey: 'private', nested: 'test-secret-123456' },
    directory,
  );
  const second = createChatTrace({ message: '另一轮' }, directory);
  const failure = new Error('Bearer abcdef test-secret-123456');
  await Promise.all([
    first.run(async () => {
      await assert.rejects(
        traceOperation('tool', { name: 'failing' }, () =>
          traceOperation('model', {}, async () => {
            throw failure;
          }),
        ),
        (error) => error === failure,
      );
    }),
    second.run(() =>
      traceOperation('tool', { name: 'success' }, async () => 'ok'),
    ),
  ]);
  const raw = readFileSync(first.file, 'utf8');
  assert.ok(
    !raw.includes('test-secret-123456') &&
      !raw.includes('abcdef') &&
      !raw.includes('private'),
  );
  const records = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map((row) => row.event),
    ['start', 'tool.start', 'model.start', 'model.error', 'tool.error'],
  );
  assert.equal(records[2].data.parentId, records[1].data.callId);
  assert.ok(!raw.includes('success'));
  assert.ok(!readFileSync(second.file, 'utf8').includes('failing'));
  first.record('large', 'x'.repeat(8 * 1024 * 1024));
  first.record('ignored', {});
  first.record('end', { aborted: true });
  const capped = readFileSync(first.file, 'utf8');
  assert.ok(
    capped.includes('truncated') &&
      capped.includes('"end"') &&
      !capped.includes('ignored'),
  );
  for (let i = 0; i < 101; i++) createChatTrace({ i }, directory);
  assert.equal(readdirSync(directory).length, 100);
  const blocked = join(directory, 'file');
  writeFileSync(blocked, 'not a directory');
  const unavailable = createChatTrace({}, blocked);
  assert.equal(
    await unavailable.run(() => traceOperation('tool', {}, async () => 42)),
    42,
  );
  await assert.rejects(
    unavailable.run(() =>
      traceOperation('tool', {}, async () => {
        throw failure;
      }),
    ),
    (error) => error === failure,
  );
  console.log(
    '后端诊断测试通过：并发隔离、关联、失败保留、脱敏、截断、轮转和写入失败隔离',
  );
} finally {
  if (previousSecret === undefined) delete process.env.CHAT_TRACE_TEST_SECRET;
  else process.env.CHAT_TRACE_TEST_SECRET = previousSecret;
  rmSync(directory, { recursive: true, force: true });
}
