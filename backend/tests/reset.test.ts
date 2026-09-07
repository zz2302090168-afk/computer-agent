import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTaskCommand } from '../tools/tasks';
void test('全部重置返回空需求，不合并旧型号与授权', () => {
  for (const text of [
    '全部重新设置需求',
    '全部重来',
    '这台全部重新来',
    '从头配',
  ]) {
    const command = detectTaskCommand(text, []);
    assert.deepEqual(command, { type: 'reset', draft: {} });
  }
});
void test('重置同句的新预算用途保留', () => {
  assert.deepEqual(detectTaskCommand('全部重来，8000元办公', []), {
    type: 'reset',
    draft: { budget: 8000, hardCap: false, purpose: '办公' },
  });
});
void test('局部修改与否定重置不能清空整台', () => {
  for (const text of [
    '只重新选CPU',
    '重新配CPU',
    '不要全部重来',
    '只重新设置显卡',
  ])
    assert.equal(detectTaskCommand(text, []), null);
});

import { searchCatalog, matchesModel } from '../services/catalog-search';
import { parts } from '../../data/seed/catalog';
void test('5060 精确查询排除 Ti，9600X 按 CPU 单独命中', () => {
  const gpu = searchCatalog(parts, { category: 'gpu', modelKeyword: '5060' });
  assert.ok(gpu.length > 0);
  assert.ok(gpu.every((p) => !p.name.includes('Ti')));
  const cpu = searchCatalog(parts, { category: 'cpu', modelKeyword: '9600x' });
  assert.equal(cpu.length, 1);
  assert.equal(matchesModel('GeForce RTX 5060 Ti 16G', '5060'), false);
  assert.equal(matchesModel('GeForce RTX 5060 Ti 16G', '5060 Ti'), true);
  assert.equal(matchesModel('Ryzen 7 9800X3D', '9800X'), false);
});
