import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanDocx } from '../services/export-docx';
import { fixture } from './pc-fixture';

void test('导出方案生成有效的 Word 文件', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  const buffer = await buildPlanDocx(plan, runtime.result!.requirements);
  assert.ok(buffer.length > 5000);
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});
