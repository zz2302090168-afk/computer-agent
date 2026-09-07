import assert from 'node:assert/strict';
const origin = process.argv[2] || 'http://localhost:3000';
const catalogResponse = await fetch(origin + '/api/catalog');
assert.equal(catalogResponse.status, 200);
const catalog = await catalogResponse.json();
assert.equal(catalog.parts.length, 160);
assert.equal(catalog.prebuilts.length, 20);
const response = await fetch(origin + '/api/recommend', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin },
  body: JSON.stringify({
    budget: 6000,
    purpose: '游戏',
    mode: 'both',
    color: '不限',
  }),
});
const data = await response.json();
assert.equal(response.status, 200, JSON.stringify(data));
assert.ok(data.plans.length > 0);
for (const p of data.plans) assert.ok(Math.abs(p.total - 6000) <= 1000);
const cookie = response.headers.get('set-cookie')?.split(';')[0];
assert.ok(cookie);
const session = await (
  await fetch(origin + '/api/session', { headers: { Cookie: cookie } })
).json();
assert.equal(session.plans.length, data.plans.length);
const other = await (await fetch(origin + '/api/session')).json();
assert.equal(other, null);
const plan = data.plans.find((p) => p.kind === 'diy');
assert.ok(plan);
const replacement = await fetch(origin + '/api/replace', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookie,
    Origin: origin,
  },
  body: JSON.stringify({
    planId: plan.id,
    oldId: plan.parts[0].id,
    newId: 'missing',
  }),
});
assert.equal(replacement.status, 400);
const bad = await fetch(origin + '/api/recommend', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ budget: -1, purpose: '游戏' }),
});
assert.equal(bad.status, 400);
const csrf = await fetch(origin + '/api/recommend', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Origin: 'https://unrelated.example',
  },
  body: JSON.stringify({ budget: 6000, purpose: '游戏' }),
});
assert.ok([400, 403].includes(csrf.status));
console.log(
  'API smoke passed: 160 parts, 20 prebuilts, ' +
    data.plans.length +
    ' plans, session persistence/isolation, unknown SKU rejection, invalid budget and cross-origin rejection.',
);
