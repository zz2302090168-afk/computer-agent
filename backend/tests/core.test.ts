import test from 'node:test';
import assert from 'node:assert/strict';
import { withinBudget, budgetRange } from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import { parseRequirements } from '../agent/requirements';
import { recommend, replacePart } from '../services/recommend';
import { parts, prebuilts } from '../../data/seed/catalog';
import { retrieveKnowledge } from '../rag/retrieve';
import {matchBenchmarks,type Benchmark} from '../performance/estimate';
const req = parseRequirements({
  budget: 6000,
  purpose: '游戏',
  mode: 'both',
  color: '不限',
});
void test('帧率仅接受同条件、有来源的记录',()=>{
 const sample:Benchmark={cpuId:'fixture-cpu',gpuId:'fixture-gpu',memoryId:'fixture-memory',game:'fixture',gameVersion:'1',driver:'1',resolution:'1080p',preset:'high',rayTracing:false,upscaling:'off',frameGeneration:false,scene:'test',fps:100,source:'https://example.com/test-fixture',testedAt:'2026-09-07'};
 const {fps:_fps,source:_source,testedAt:_tested,...conditions}=sample;
 assert.equal(matchBenchmarks(conditions,[]).status,'insufficient');
 assert.equal(matchBenchmarks({...conditions,frameGeneration:true},[sample]).status,'insufficient');
 assert.deepEqual(matchBenchmarks(conditions,[sample]).range,[100,100]);
});
void test('预算严格覆盖正负1000边界与明确上限', () => {
  assert.ok(withinBudget(5000, 6000));
  assert.ok(withinBudget(7000, 6000));
  assert.ok(!withinBudget(4999.99, 6000));
  assert.ok(!withinBudget(7000.01, 6000));
  assert.ok(!withinBudget(6000.01, 6000, true));
  for (const x of [NaN, Infinity, -1, 0]) assert.throws(() => budgetRange(x));
});
void test('160个SKU，无库存数量或在售字段', () => {
  assert.equal(parts.length, 160);
  for (const c of new Set(parts.map((p) => p.category)))
    assert.equal(parts.filter((p) => p.category === c).length, 20);
  for (const p of parts) {
    assert.ok(!('stock' in p));
    assert.ok(!('status' in p));
  }
});
void test('全部演示整机可通过规格校验', () => {
  for (const pc of prebuilts) {
    const ps = pc.partIds.map((id) => parts.find((p) => p.id === id)!);
    assert.equal(validateBuild(ps).status, 'pass', pc.id);
  }
});
void test('接口、尺寸、缺失规格和重复类别不能被当成兼容', () => {
  const ps = prebuilts[0].partIds.map((id) =>
    structuredClone(parts.find((p) => p.id === id)!),
  );
  ps.find((p) => p.category === 'memory')!.specs.ddr = 'DDR5';
  assert.equal(validateBuild(ps).status, 'fail');
  ps.find((p) => p.category === 'memory')!.specs.ddr = 'DDR4';
  delete ps.find((p) => p.category === 'gpu')!.specs.length;
  assert.equal(validateBuild(ps).status, 'unknown');
  assert.equal(validateBuild([...ps, ps[0]]).status, 'fail');
});
void test('所有预算用途返回的配置均满足硬约束', () => {
  let count = 0;
  for (const budget of [3000, 6000, 10000, 18000, 30000])
    for (const purpose of ['游戏', '办公', '编程', '本地 AI']) {
      const r = { ...req, budget, purpose };
      for (const p of recommend(r, parts, prebuilts)) {
        count++;
        assert.ok(withinBudget(p.total, budget));
        assert.equal(p.parts.length, 8);
        assert.equal(validateBuild(p.parts).status, 'pass');
      }
    }
  assert.ok(count > 20);
});
void test('不可能预算返回空，不强行凑方案', () =>
  assert.deepEqual(
    recommend({ ...req, budget: 1, hardCap: true }, parts, prebuilts),
    [],
  ));
void test('硬上限、白色与整机模式生效', () => {
  const r = parseRequirements({ ...req, message: '最多6000元，白色整机' });
  assert.ok(r.hardCap);
  for (const p of recommend(r, parts, prebuilts)) {
    assert.equal(p.kind, 'prebuilt');
    assert.ok(p.total <= 6000);
    assert.equal(p.parts.find((x) => x.category === 'case')?.color, '白色');
  }
});
void test('替换不能注入未知商品或跨类别商品', () => {
  const p = recommend({ ...req, mode: 'diy' }, parts, prebuilts)[0];
  assert.ok(p);
  assert.throws(() => replacePart(p, p.parts[0].id, 'missing', req, parts));
  assert.throws(() => replacePart(p, p.parts[0].id, 'case-0', req, parts));
});
void test('知识检索返回有来源的DDR文档', () => {
  const docs = retrieveKnowledge('DDR4 DDR5 内存 主板');
  assert.ok(docs.some((d) => d.id === 'compat-memory' && d.source));
});
