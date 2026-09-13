import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildPlanDocx } from '../services/export-docx';
import { fixture } from './pc-fixture';

const JSZip = createRequire(import.meta.resolve('docx'))('jszip');

async function documentContent(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml: string = await zip.file('word/document.xml').async('string');
  const text = (value: string) =>
    [...value.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join(' | ');
  return {
    text: text(xml),
    rows: [...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map(([row]) =>
      text(row),
    ),
  };
}

void test('导出方案生成有效的 Word 文件', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  const buffer = await buildPlanDocx(plan, runtime.result!.requirements);
  assert.ok(buffer.length > 5000);
  assert.deepEqual([...buffer.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
});

void test('导出混合目录逐件区分演示型号与真实商品，并说明演示报价', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  plan.parts[0]!.demo = false;
  const content = await documentContent(
    await buildPlanDocx(plan, runtime.result!.requirements),
  );

  for (const part of plan.parts) {
    const row = content.rows.find((value) =>
      value.startsWith(`${part.categoryLabel} | `),
    );
    assert.ok(row);
    assert.ok(
      row.includes(
        `${part.brand} ${part.name}（${part.demo ? '演示型号' : '真实商品'}）`,
      ),
    );
  }
  assert.match(
    content.text,
    /标注“演示型号”的配件仅用于演示，不代表真实商品报价/,
  );
});

void test('纯真实商品方案不添加演示说明', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  for (const part of plan.parts) part.demo = false;
  plan.demo = false;
  const content = await documentContent(
    await buildPlanDocx(plan, runtime.result!.requirements),
  );

  assert.equal(
    (content.text.match(/真实商品/g) ?? []).length,
    plan.parts.length,
  );
  assert.doesNotMatch(content.text, /演示/);
});

void test('配色摘要保留单件例外并排除CPU硬盘与无效重复覆盖', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  plan.parts.find((part) => part.category === 'case')!.color = '白色';
  const requirements = {
    ...runtime.result!.requirements,
    color: '黑色',
    partColors: {
      case: '白色',
      gpu: '不限',
      memory: '黑色',
      cpu: '白色',
      storage: '白色',
    },
  };
  const content = await documentContent(
    await buildPlanDocx(plan, requirements),
  );
  const colorRow = content.rows.find((row) => row.startsWith('配色要求 | '));

  assert.ok(colorRow);
  assert.match(colorRow, /默认配色：黑色/);
  assert.match(colorRow, /单件覆盖：/);
  assert.match(colorRow, /机箱 白色/);
  assert.match(colorRow, /GPU 不限/);
  assert.match(colorRow, /优先于默认配色/);
  assert.doesNotMatch(colorRow, /CPU|硬盘|内存/);
});

void test('无生效单件例外时配色摘要只显示默认要求', async () => {
  const { runtime } = fixture();
  const requirements = {
    ...runtime.result!.requirements,
    color: '黑色优先，白色备选',
    partColors: { case: '黑色优先，白色备选' },
  };
  const content = await documentContent(
    await buildPlanDocx(runtime.result!.plans[0]!, requirements),
  );

  assert.equal(
    content.rows.find((row) => row.startsWith('配色要求 | ')),
    '配色要求 | 默认配色：黑色优先，白色备选',
  );
});

void test('商家整机导出继续说明不审核DIY兼容性与整机售价依据', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  plan.kind = 'prebuilt';
  plan.validation = { status: 'not_applicable', issues: [] };
  const content = await documentContent(
    await buildPlanDocx(plan, runtime.result!.requirements),
  );

  assert.match(content.text, /商家整机，不执行 DIY 配件兼容性审核/);
  assert.match(content.text, /整机售价以商家整机目录价为准/);
  assert.doesNotMatch(content.text, /已录入规格未发现兼容冲突/);
});

void test('配件均真实的演示整机仍在导出中标明演示性质', async () => {
  const { runtime } = fixture();
  const plan = runtime.result!.plans[0]!;
  plan.kind = 'prebuilt';
  plan.demo = true;
  for (const part of plan.parts) part.demo = false;
  const content = await documentContent(
    await buildPlanDocx(plan, runtime.result!.requirements),
  );
  assert.match(content.text, /本方案含演示商品，方案名称和总价仅供演示/);
  assert.doesNotMatch(content.text, /演示型号/);
});
