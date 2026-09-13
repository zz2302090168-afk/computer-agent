import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatState } from '../agent/conversation';
import { planActionResponse } from '../api/plan-actions';
import { editPlan } from '../services/edit-plan';
import { selectPlan } from '../services/select-plan';
import {
  applyPlanActionResponse,
  applyRequirementSnapshot,
  applyWorkspaceResponse,
} from '../../frontend/result-state';
import { fixture } from './pc-fixture';

function workspace(): ChatState {
  const { runtime } = fixture();
  const task = runtime.task;
  return {
    currentTaskId: task.id,
    draft: task.draft,
    result: task.result,
    task,
    tasks: [
      {
        id: task.id,
        name: task.name,
        version: task.version,
        updatedAt: task.updatedAt,
      },
    ],
    messages: [{ role: 'user', content: '确认当前主机', taskId: task.id }],
  };
}

void test('确认后替换的完整响应清除旧确认与评估，并同步任务版本', () => {
  const { catalog } = fixture();
  const state = workspace();
  const confirmed = selectPlan(
    state.task!,
    'plan-1',
    catalog,
    { source: 'ui' },
    true,
  );
  confirmed.version = 2;
  confirmed.updatedAt = 2;
  confirmed.result!.evaluation = {
    planId: 'plan-1',
    issues: [],
    directions: ['旧方案评估'],
    suggestions: [],
    evidence: [],
    createdAt: 2,
  };
  const selectedState = applyPlanActionResponse(
    state,
    planActionResponse(confirmed),
  );
  assert.equal(selectedState.result?.selection?.status, 'confirmed');

  const replaced = editPlan(
    confirmed,
    'plan-1',
    [{ oldId: 'gpu', newId: 'gpu-upper' }],
    catalog,
  );
  replaced.version = 3;
  replaced.updatedAt = 3;
  // 浏览器接收 JSON 后，服务端置为 undefined 的旧确认/评估键已经消失。
  const response = JSON.parse(JSON.stringify(planActionResponse(replaced)));
  const next = applyPlanActionResponse(selectedState, response);
  assert.equal(next.result?.selection, undefined);
  assert.equal(next.result?.evaluation, undefined);
  assert.equal(
    next.result?.plans[0]?.parts.find((part) => part.category === 'gpu')?.id,
    'gpu-upper',
  );
  assert.equal(next.draft.selectionSources?.gpu, 'user');
  assert.deepEqual(next.draft.selectionConfirmationMessageIds, {});
  assert.equal(next.task?.version, 3);
  assert.equal(next.task?.updatedAt, 3);
  assert.equal(next.tasks?.[0]?.version, 3);
  assert.equal(next.tasks?.[0]?.budget, replaced.draft.budget);
  assert.equal(next.task?.result, next.result);
  assert.equal(next.task?.draft, next.draft);
  assert.equal(next.messages, state.messages);
  assert.ok(next.result && !('taskId' in next.result));
});

void test('旧确认响应晚于新聊天方案时保留新需求与结果', () => {
  const state = workspace();
  const oldResponse = planActionResponse({ ...state.task!, version: 2 });
  const current: ChatState = {
    ...state,
    task: { ...state.task!, version: 3 },
    draft: { ...state.draft, color: '白色' },
    result: { ...state.result!, summary: '新白色方案' },
  };
  assert.equal(applyPlanActionResponse(current, oldResponse), current);
  assert.equal(current.draft.color, '白色');
  assert.equal(current.result?.summary, '新白色方案');
});

void test('切换任务后忽略原任务返回的方案操作', () => {
  const state = workspace();
  const response = planActionResponse({ ...state.task!, version: 2 });
  const switched = {
    ...state,
    currentTaskId: 'another-task',
    task: { ...state.task!, id: 'another-task' },
  };
  assert.equal(applyPlanActionResponse(switched, response), switched);
});

void test('旧聊天或恢复响应晚于确认时更新消息但保留新配置及当前任务摘要', () => {
  const state = workspace();
  const { catalog } = fixture();
  const confirmed = selectPlan(
    state.task!,
    'plan-1',
    catalog,
    { source: 'ui' },
    true,
  );
  confirmed.version = 2;
  confirmed.updatedAt = 2;
  const current = applyPlanActionResponse(state, planActionResponse(confirmed));
  const otherTask = {
    id: 'other-task',
    name: '另一台主机',
    version: 4,
    updatedAt: 4,
  };
  const incoming = {
    ...state,
    tasks: [...state.tasks!, otherTask],
    messages: [
      ...state.messages,
      { role: 'assistant' as const, content: '方案解释已完成' },
    ],
  };
  const next = applyWorkspaceResponse(current, incoming);
  assert.equal(next.task, current.task);
  assert.equal(next.result?.selection?.status, 'confirmed');
  assert.equal(next.result, current.result);
  assert.equal(next.draft, current.draft);
  assert.equal(next.messages, incoming.messages);
  assert.equal(
    next.tasks?.find((task) => task.id === state.task!.id)?.version,
    2,
  );
  assert.equal(
    next.tasks?.find((task) => task.id === otherTask.id),
    otherTask,
  );

  const withoutCurrent = applyWorkspaceResponse(current, {
    ...incoming,
    tasks: [otherTask],
  });
  assert.equal(withoutCurrent.tasks?.length, 2);
  assert.equal(
    withoutCurrent.tasks?.find((task) => task.id === state.task!.id)?.version,
    2,
  );
});

void test('相同版本和更新版本的工作区响应仍正常接收', () => {
  const state = workspace();
  const same = {
    ...state,
    messages: [{ role: 'assistant' as const, content: '咨询回复' }],
  };
  assert.equal(applyWorkspaceResponse(state, same), same);
  const newer = { ...same, task: { ...state.task!, version: 2 } };
  assert.equal(applyWorkspaceResponse(state, newer), newer);
});

void test('工作区响应可以合法切换到版本更低的新任务', () => {
  const state = workspace();
  const current = { ...state, task: { ...state.task!, version: 5 } };
  const switched = {
    ...state,
    currentTaskId: 'new-task',
    task: { ...state.task!, id: 'new-task', version: 1 },
  };
  assert.equal(applyWorkspaceResponse(current, switched), switched);
});

void test('生成结束前同步已知需求，保留聊天并拒绝旧版本或其他会话', () => {
  const state = workspace();
  const task = {
    ...state.task!,
    version: state.task!.version + 1,
    draft: { budget: 10000, purpose: '游戏', color: '黑色' },
    result: null,
  };
  const next = applyRequirementSnapshot(state, task);
  assert.deepEqual(next.draft, task.draft);
  assert.equal(next.messages, state.messages);
  assert.equal(next.result, null);
  assert.equal(applyRequirementSnapshot(next, state.task!), next);
  assert.equal(
    applyRequirementSnapshot(next, { ...task, id: 'other-page' }),
    next,
  );
});
