import assert from 'node:assert/strict';
const url='http://localhost:3000/api/chat';const r=await fetch(url,{method:'PUT'});const cookie=r.headers.get('set-cookie').split(';')[0];let state=await r.json();
async function send(message){const res=await fetch(url,{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:JSON.stringify({message,taskId:state.currentTaskId})});state=await res.json();assert.equal(res.status,200,JSON.stringify(state));console.log(JSON.stringify({message,answer:state.messages.at(-1).content,plans:state.result?.plans.length}));}
await send('6000元游戏DIY，显卡5060和CPU9600X，其他你选');assert.ok(state.result.plans.length);
const before=JSON.stringify(state.result.plans);await send('还能改进吗');assert.equal(JSON.stringify(state.result.plans),before);assert.ok(!/已.*(?:重新搭配|完成选配|更新)/.test(state.messages.at(-1).content));
await send('为什么这样选');assert.equal(JSON.stringify(state.result.plans),before);
await send('全部重新设置需求');assert.deepEqual(state.draft,{});assert.equal(state.result,null);
console.log('PASS: real-model selection, read-only advice, explanation, reset');
