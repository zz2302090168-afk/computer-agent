import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './pc-fixture';
import { addSyntheticThermalEvidence } from './thermal-fixture';
import {
  acceptRequirements,
  inspectRequirements,
  assertRequirements,
} from '../services/requirement-acceptance';
import { auditDeliveryAsync } from '../services/delivery-audit';
import { assembleBuildTool } from '../tools/build/assemble';
import { replacePartsTool } from '../tools/build/edit';
import { updateRequirementsTool } from '../tools/requirements/update';
import { applyDraft, completeRequirements } from '../agent/conversation-state';
import { judgeRequirements } from '../agent/jev-requirements';
import { ToolExecutionError } from '../domain/errors';
import { exploreParallelPlans } from '../agent/parallel-plans';
import type {
  RequirementItem,
  RequirementAcceptance,
  RequirementCheck,
} from '../domain/requirement-acceptance';

const item = (patch: Partial<RequirementItem> = {}): RequirementItem => ({
  id: 'ram',
  text: '内存至少32GB',
  sourceMessageId: 'current',
  strength: 'hard',
  active: true,
  version: 1,
  category: 'memory',
  field: 'capacity',
  rule: 'min',
  expected: 32,
  ...patch,
});
const setup = (items: RequirementItem[] = [item()]) => {
  const f = fixture();
  f.runtime.draft.requirementItems = items;
  const r = completeRequirements(f.runtime.draft);
  const ids = f.runtime.result!.plans[1].parts.map((part) => part.id);
  const parts = ids.map((id) =>
    f.catalog.parts.find((part) => part.id === id)!,
  );
  return { ...f, r, ids, parts };
};
function observation(error: unknown) {
  assert.ok(error instanceof ToolExecutionError);
  return error.observation as RequirementAcceptance & {
    code: string;
    issues: (RequirementCheck & { action: string })[];
  };
}
const reject = (id: string, status: string) => (error: unknown) => {
  const report = observation(error);
  assert.equal(report.stage, 'requirements');
  assert.equal(
    report.checks.find((check) => check.requirementId === id)?.status,
    status,
  );
  return true;
};
const semantic = item({
  id: 'appearance',
  category: 'case',
  field: 'appearance',
  rule: 'semantic',
  expected: '简洁，没有明显灯光装饰',
  text: '不要花哨灯光',
});
void test('规则失败不调用语义服务；软性品牌不触发硬性筛选', async () => {
  const f = setup([item({ expected: 64 }), semantic]);
  f.parts.find((part) => part.category === 'case')!.specs.appearance = '纯色';
  let calls = 0;
  await assert.rejects(
    acceptRequirements(f.parts, f.r, 8000, f.catalog.parts, undefined, {
      key: 'synthetic',
      request: async () => {
        calls++;
        throw Error('不得调用');
      },
    }),
    reject('ram', 'fail'),
  );
  assert.equal(calls, 0);
  const { version: _version, ...brand } = item({
    id: 'brand',
    text: '最好AMD',
    category: 'cpu',
    field: 'brand',
    rule: 'equals',
    expected: 'AMD',
    strength: 'soft',
  });
  const r = completeRequirements(
    applyDraft({ ...f.r, requirementItems: [] }, { requirementItems: [brand] }),
  );
  const report = await acceptRequirements(f.parts, r, 8000, f.catalog.parts);
  assert.equal(report.passed, true);
  assert.equal(
    report.checks.find((check) => check.requirementId === 'brand')?.status,
    'fail',
  );
});
void test('换件修复不能扩大第一次声明的范围，也不能删除首次需求', async () => {
  const f = setup();
  f.context.messages[0].content = '只换显卡，内存至少64GB';
  const { version: _version, ...ram } = item({
    expected: 64,
    text: '内存至少64GB',
  });
  const args = {
    planId: 'plan-1',
    sourceMessageId: 'current',
    replacements: [{ oldId: 'gpu', newId: 'gpu-more-power' }],
    requirementItems: [ram],
  };
  await assert.rejects(
    replacePartsTool.execute(args, f.context, f.runtime),
    reject('ram', 'fail'),
  );
  await assert.rejects(
    replacePartsTool.execute(
      { ...args, requirementItems: [] },
      f.context,
      f.runtime,
    ),
    /不能修改或删除/,
  );
  await assert.rejects(
    replacePartsTool.execute(
      {
        ...args,
        replacements: [
          ...args.replacements,
          { oldId: 'psu', newId: 'psu-1000' },
        ],
      },
      f.context,
      f.runtime,
    ),
    /不能扩大替换范围/,
  );
  assert.equal(f.saved.length, 0);
});
const answer = (choice = 'pass', confidence = 0.99) => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: {
    pass: choice === 'pass' ? 0.98 : 0.01,
    fail: choice === 'fail' ? 0.98 : 0.01,
    unknown: choice === 'unknown' ? 0.98 : 0.01,
  },
});

void test('全部规则硬需求满足：零Jev调用、兼容性pass后才保存', async (t) => {
  const f = setup();
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw Error('不应该调用');
  });
  await assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(f.runtime.result!.plans[0].validation.status, 'pass');
  assert.equal(f.runtime.result!.plans[0].requirementAcceptance?.passed, true);
  assert.equal(f.saved.filter((task) => task.result).length, 1);
});
void test('预算、容量、不要水冷分别定位；规则失败优先于适配性且原方案不变', async () => {
  for (const failure of ['budget', 'ram', 'cooling']) {
    const f = setup([
      item(),
      item({
        id: 'cooling',
        text: '不要水冷',
        category: 'cooler',
        field: 'coolingType',
        rule: 'not_equals',
        expected: '水冷',
      }),
    ]);
    f.parts.find((p) => p.category === 'cooler')!.specs.coolingType =
      failure === 'cooling' ? 'liquid' : 'air';
    if (failure === 'ram')
      f.parts.find((p) => p.category === 'memory')!.specs.capacity = 16;
    if (failure === 'budget') f.ids[f.ids.indexOf('gpu')] = 'gpu-over-limit';
    // 同时有适配性冲突，仍必须先报告需求失败。
    f.parts.find((p) => p.category === 'motherboard')!.specs.socket = '冲突';
    const original = structuredClone(f.runtime.result);
    await assert.rejects(
      assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime),
      reject(failure === 'budget' ? 'builtin:budget' : failure, 'fail'),
    );
    assert.deepEqual(f.runtime.result, original);
    assert.equal(f.saved.length, 0);
  }
});
void test('软性尺寸偏好失败仅提示；明确尺寸上限硬失败', async () => {
  const soft = item({
    id: 'small',
    text: '尽量小一点',
    category: 'case',
    field: 'volume',
    expected: 20,
    rule: 'max',
    strength: 'soft',
  });
  const f = setup([soft]);
  f.parts.find((p) => p.category === 'case')!.specs.volume = 30;
  const report = await acceptRequirements(f.parts, f.r, 8000, f.catalog.parts);
  assert.equal(report.passed, true);
  assert.equal(
    report.checks.find((c) => c.requirementId === 'small')?.status,
    'fail',
  );
  f.r.requirementItems![0] = {
    ...soft,
    text: '体积不超过20升',
    strength: 'hard',
  };
  await assert.rejects(
    acceptRequirements(f.parts, f.r, 8000, f.catalog.parts),
    reject('small', 'fail'),
  );
});
void test('缺资料与推定资料为unknown，不建议直接换件', async () => {
  for (const mode of ['missing', 'inferred']) {
    const f = setup();
    const ram = f.parts.find((p) => p.category === 'memory')!;
    if (mode === 'missing') delete ram.specs.capacity;
    else
      ram.specs.provenance = {
        capacity: { origin: 'synthetic', status: 'inferred' },
      };
    await assert.rejects(
      acceptRequirements(f.parts, f.r, 8000, f.catalog.parts),
      (error) => {
        const report = observation(error);
        const check = report.issues.find((c) => c.requirementId === 'ram')!;
        assert.equal(check.status, 'unknown');
        assert.match(check.action, /补查.*不得.*换件/);
        assert.ok(check.missingInformation.length);
        return true;
      },
    );
  }
});
void test('语义批量一次调用，遗漏任一硬需求答案或低置信度不能通过', async () => {
  const f = setup([semantic, { ...semantic, id: 'second' }]);
  f.parts.find((p) => p.category === 'case')!.specs.appearance =
    '纯色外壳，无灯';
  let calls = 0;
  const request: typeof fetch = async (_url, options) => {
    calls++;
    assert.equal(typeof options?.body, 'string');
    assert.equal(
      Object.keys(JSON.parse(options!.body as string).questions).length,
      2,
    );
    return Response.json({ answers: { r0: answer() } });
  };
  await assert.rejects(
    acceptRequirements(f.parts, f.r, 8000, f.catalog.parts, undefined, {
      key: 'synthetic',
      request,
    }),
    reject('second', 'unknown'),
  );
  assert.equal(calls, 1);
  const report = inspectRequirements(f.parts, f.r, 8000, f.catalog.parts);
  const result = await judgeRequirements(
    report.checks.filter((c) => c.requirementId === semantic.id),
    {
      key: 'synthetic',
      request: async () =>
        Response.json({ answers: { r0: answer('pass', 0.4) } }),
    },
  );
  assert.equal(result.appearance, 'unknown');
});
void test('Jev无凭据、异常、超时及格式错误均受控unknown', async () => {
  const f = setup([semantic]);
  f.parts.find((p) => p.category === 'case')!.specs.appearance = '纯色';
  let calls = 0;
  await assert.rejects(
    acceptRequirements(f.parts, f.r, 8000, f.catalog.parts, undefined, {
      key: '',
      request: async () => {
        calls++;
        throw Error();
      },
    }),
    reject(semantic.id, 'unknown'),
  );
  assert.equal(calls, 0);
  for (const request of [
    async () => {
      throw Error('服务异常');
    },
    async () =>
      Response.json({
        answers: { r0: { ...answer(), probabilities: { pass: 1 } } },
      }),
    async () => new Response('', { status: 503 }),
    async () => new Response('not json'),
    async (_url: unknown, options?: RequestInit) =>
      new Promise<Response>((_resolve, rejectPromise) => {
        const keepAlive = setTimeout(
          () => rejectPromise(Error('timeout not enforced')),
          2500,
        );
        options?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(keepAlive);
            rejectPromise(options.signal!.reason);
          },
          { once: true },
        );
      }),
  ])
    await assert.rejects(
      acceptRequirements(f.parts, f.r, 8000, f.catalog.parts, undefined, {
        key: 'synthetic',
        request,
      }),
      reject(semantic.id, 'unknown'),
    );
});
void test('通过凭证重审不多调Jev；篡改、需求变更或商品变更均失效', async () => {
  const f = setup([semantic]);
  f.parts.find((p) => p.category === 'case')!.specs.appearance = '纯色';
  addSyntheticThermalEvidence(f.catalog.parts);
  let calls = 0;
  const options = {
    key: 'synthetic',
    request: async () => {
      calls++;
      return Response.json({ answers: { r0: answer() } });
    },
  };
  const receipt = await acceptRequirements(
    f.parts,
    f.r,
    8000,
    f.catalog.parts,
    undefined,
    options,
  );
  const plan = {
    ...f.runtime.result!.plans[1],
    parts: f.parts,
    requirementAcceptance: receipt,
  };
  await auditDeliveryAsync([plan], f.r, f.catalog, options);
  assert.equal(calls, 1);
  const forged = { ...receipt, checks: [] };
  assert.throws(
    () =>
      assertRequirements(
        f.parts,
        f.r,
        8000,
        f.catalog.parts,
        undefined,
        forged,
      ),
    reject(semantic.id, 'unknown'),
  );
  f.r.requirementItems![0] = { ...semantic, version: 2, expected: '透明侧板' };
  assert.throws(
    () =>
      assertRequirements(
        f.parts,
        f.r,
        8000,
        f.catalog.parts,
        undefined,
        receipt,
      ),
    reject(semantic.id, 'unknown'),
  );
  f.r.requirementItems = [semantic];
  f.parts[0].specs.changed = true;
  assert.throws(
    () =>
      assertRequirements(
        f.parts,
        f.r,
        8000,
        f.catalog.parts,
        undefined,
        receipt,
      ),
    reject(semantic.id, 'unknown'),
  );
});
void test('适配性unknown阻断，补齐对应配置证据后才交付；规格变化使旧证据失效', async () => {
  const f = setup();
  const box = f.parts.find((p) => p.category === 'case')!;
  delete box.specs.thermalAssessments;
  await assert.rejects(
    assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime),
    (error) => {
      assert.equal(observation(error).code, 'compatibility_unconfirmed');
      return true;
    },
  );
  assert.equal(f.saved.length, 0);
  addSyntheticThermalEvidence(f.catalog.parts);
  await assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime);
  f.parts[0].specs.newRevision = 2;
  await assert.rejects(
    assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime),
    /适配性无法确认/,
  );
});
void test('适配性修复后再次验收需求：换大机箱导致超预算被拦截', async () => {
  const f = setup();
  f.ids[f.ids.indexOf('gpu')] = 'gpu-too-long';
  await assert.rejects(
    assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime),
    /显卡过长/,
  );
  const larger = f.catalog.parts.find((p) => p.id === 'case-premium')!;
  larger.specs.gpuLength = 500;
  f.ids[f.ids.indexOf('case')] = larger.id;
  await assert.rejects(
    assembleBuildTool.execute({ productIds: f.ids }, f.context, f.runtime),
    reject('builtin:budget', 'fail'),
  );
  assert.equal(f.saved.length, 0);
});
void test('除了显卡都别换：七项锁定，越权换电源失败保留原方案', async () => {
  const f = setup([]);
  const locks = f.parts
    .filter((p) => p.category !== 'gpu')
    .map((p) =>
      item({
        id: `lock-${p.category}`,
        text: '除了显卡都别换',
        category: p.category,
        field: 'id',
        rule: 'preserve',
        expected: p.id,
      }),
    );
  f.runtime.draft.requirementItems = locks;
  f.context.messages[0].content = '除了显卡都别换';
  const original = structuredClone(f.runtime.result);
  await assert.rejects(
    replacePartsTool.execute(
      {
        planId: 'plan-1',
        sourceMessageId: 'current',
        replacements: [
          { oldId: 'gpu', newId: 'gpu-more-power' },
          { oldId: 'psu', newId: 'psu-1000' },
        ],
      },
      f.context,
      f.runtime,
    ),
    reject('lock-psu', 'fail'),
  );
  assert.deepEqual(f.runtime.result, original);
  assert.equal(f.saved.length, 0);
  await replacePartsTool.execute(
    {
      planId: 'plan-1',
      sourceMessageId: 'current',
      replacements: [{ oldId: 'gpu', newId: 'gpu-cheaper' }],
    },
    f.context,
    f.runtime,
  );
  assert.deepEqual(
    f.runtime
      .result!.plans[0].parts.filter((p) => p.category !== 'gpu')
      .map((p) => p.id),
    f.parts.filter((p) => p.category !== 'gpu').map((p) => p.id),
  );
});
void test('多轮合并不遗漏旧需求，明确更新保留ID并提高版本；中文限制原文绑定', async () => {
  const f = setup([]);
  f.runtime.result = null;
  f.context.messages[0].content = '内存至少32GB，不要水冷，别超预算';
  const { version: _v, ...ram } = item();
  const { version: _w, ...cooling } = item({
    id: 'cooling',
    text: '不要水冷',
    category: 'cooler',
    field: 'coolingType',
    rule: 'not_equals',
    expected: '水冷',
  });
  await updateRequirementsTool.execute(
    { requirementItems: [ram, cooling], hardCap: true },
    f.context,
    f.runtime,
  );
  const originalVersion = f.runtime.draft.requirementItems![0].version;
  f.context.messages[0].content = '内存改为至少64GB';
  await updateRequirementsTool.execute(
    { requirementItems: [{ ...ram, text: '内存改为至少64GB', expected: 64 }] },
    f.context,
    f.runtime,
  );
  assert.equal(f.runtime.draft.requirementItems!.length, 2);
  assert.equal(
    f.runtime.draft.requirementItems![0].version,
    originalVersion + 1,
  );
  assert.equal(f.runtime.draft.hardCap, true);
  await assert.rejects(
    updateRequirementsTool.execute(
      { requirementItems: [{ ...cooling, active: false }] },
      f.context,
      f.runtime,
    ),
    /逐字引用/,
  );
  const merged = applyDraft(f.runtime.draft, { requirementItems: [] });
  assert.equal(merged.requirementItems!.length, 2);
  assert.throws(
    () =>
      applyDraft(merged, { requirementItems: [{ ...ram, rule: 'semantic' }] }),
    /精确判断/,
  );
});
const response = (ids: string[], turn: number) =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: 'assemble_build', arguments: JSON.stringify({ productIds: ids }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
void test('真实选型循环mock：收到失败observation后修正，再验收且不遗漏容量约束', async (t) => {
  const f = setup([
    item(),
    item({
      id: 'cooling',
      text: '不要水冷',
      category: 'cooler',
      field: 'coolingType',
      rule: 'not_equals',
      expected: '水冷',
    }),
  ]);
  const air = f.catalog.parts.find((p) => p.id === 'cooler')!;
  air.specs.coolingType = 'air';
  const water = {
    ...structuredClone(air),
    id: 'water',
    specs: { ...air.specs, coolingType: 'liquid' },
  };
  f.catalog.parts.push(water);
  addSyntheticThermalEvidence(f.catalog.parts);
  f.context.modelConfig = {
    base: 'https://mock.invalid/v1',
    key: 'synthetic',
    model: 'synthetic',
  };
  let calls = 0;
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 2) {
        assert.equal(typeof init?.body, 'string');
        const messages = JSON.parse(init!.body as string).messages;
        const last = JSON.parse(messages.at(-1).content);
        assert.equal(last.observation.code, 'requirement_acceptance_failed');
        assert.equal(
          last.observation.checks.find(
            (c: RequirementCheck) => c.requirementId === 'ram',
          ).status,
          'pass',
        );
      }
      return response(
        f.ids.map((id) => (id === 'cooler' && calls === 1 ? 'water' : id)),
        calls,
      );
    },
  );
  const result = await exploreParallelPlans(
    [f.runtime.result!.plans[1]],
    f.context,
    f.runtime,
    [assembleBuildTool],
  );
  assert.equal(calls, 2);
  assert.equal(result[0].requirementAcceptance?.passed, true);
  assert.equal(result[0].validation.status, 'pass');
  assert.equal(f.saved.length, 0);
});
void test('连续修复失败：现有候选上限及去重生效，带回具体问题，无副作用', async (t) => {
  const f = setup([item({ expected: 64 })]);
  f.context.modelConfig = {
    base: 'https://mock.invalid/v1',
    key: 'synthetic',
    model: 'synthetic',
  };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    const gpu = ['gpu', 'gpu-cheaper', 'gpu-upper', 'gpu-over-limit'][
      Math.min(calls++, 3)
    ];
    return response(
      f.ids.map((id) => (id === 'gpu' ? gpu : id)),
      calls,
    );
  });
  const original = structuredClone(f.runtime.result);
  await assert.rejects(
    exploreParallelPlans([f.runtime.result!.plans[1]], f.context, f.runtime, [
      assembleBuildTool,
    ]),
    reject('ram', 'fail'),
  );
  assert.equal(calls, 4);
  assert.equal(f.saved.length, 0);
  assert.deepEqual(f.runtime.result, original);
});
