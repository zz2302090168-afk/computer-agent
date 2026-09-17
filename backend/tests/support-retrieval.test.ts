import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledge } from '../../knowledge/library';
import { supportKnowledge, supportTopicIds } from '../../knowledge/support';
import { retrieveEvidence } from '../rag/evidence';
import { retrieveKnowledgeTool } from '../tools/knowledge/retrieve';
import { embeddingConfig, embeddingFetch } from './embedding-fixture';
import { fixture } from './pc-fixture';

const displayQuery = {
  query: '显示器无信号',
  category: 'support',
  topicId: 'support-no-display',
};
type RetrievalResult = {
  evidence: typeof supportKnowledge;
  knowledgeStatus: string;
  knowledgeSource?: string;
  knowledgeFailure?: string;
  knowledgeNotice: string;
};

void test('售前检索保留知识正文及来源元数据，返回证据边界且不生成售后状态', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  const output = (await retrieveKnowledgeTool.execute(
    { query: '显卡厂商和型号的区别', category: 'sales' },
    f.context,
    f.runtime,
  )) as Awaited<ReturnType<typeof retrieveEvidence>> & {
    knowledgeSource: string;
    evidenceScope: string;
  };
  assert.ok(output && !Array.isArray(output));
  assert.equal(typeof output.evidenceScope, 'string');
  assert.equal(output.knowledgeStatus, 'available');
  assert.equal(output.knowledgeSource, 'embedding');
  assert.equal(output.knowledgeFailure, undefined);
  assert.ok(output.evidence.length);
  for (const hit of output.evidence) {
    const original = knowledge.find((item) => item.id === hit.id)!;
    assert.notEqual(hit.category, 'support');
    assert.equal(hit.content, original.content);
    assert.equal(hit.source, original.source);
    assert.equal(hit.checkedAt, original.checkedAt);
  }
  assert.equal(f.runtime.supportRetrieval, undefined);
  assert.equal(f.runtime.supportEvidence, undefined);
  assert.equal(f.saved.length, 0);
});

void test('售后文档标题提供可核对的步骤类型，正文和来源属性保持原样', () => {
  assert.equal(supportTopicIds.length, 9);
  assert.equal(new Set(supportTopicIds).size, supportTopicIds.length);
  for (const [id, expected] of [
    ['support-no-display.1', 'context'],
    ['support-no-display.3', 'clarification'],
    ['support-no-display.4', 'step'],
    ['support-no-display.8', 'stop'],
  ]) {
    const block = supportKnowledge.find((item) => item.id === id)!;
    assert.equal(block.supportKind, expected);
    assert.equal(block.kind, 'general_guide');
    assert.equal(block.source, null);
    assert.equal(block.checkedAt, null);
    assert.ok(block.content.length);
  }
  assert.equal(
    supportKnowledge.find((item) => item.id === 'support-no-display.4')!
      .sectionTitle,
    '步骤1：确认显示器自身工作',
  );
});

void test('证据层区分服务故障和无匹配，取消继续抛出', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const empty = await retrieveEvidence(
    embeddingConfig,
    '显示器',
    4,
    'support',
    'unknown-topic',
  );
  assert.equal(empty.knowledgeFailure, 'no_match');
  assert.deepEqual(empty.evidence, []);
  const failed = await retrieveEvidence(
    {},
    '显示器',
    4,
    'support',
    'support-no-display',
  );
  assert.equal(failed.knowledgeFailure, 'service_error');
  assert.deepEqual(failed.evidence, []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retrieveEvidence(
      {},
      '显示器',
      4,
      'support',
      'support-no-display',
      controller.signal,
    ),
    { name: 'AbortError' },
  );
});

void test('售后服务故障仅按明确主题返回本地原文，标记来源且不声称厂家核验', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  const f = fixture();
  const output = (await retrieveKnowledgeTool.execute(
    displayQuery,
    f.context,
    f.runtime,
  )) as RetrievalResult;
  assert.equal(output.knowledgeStatus, 'available');
  assert.equal(output.knowledgeSource, 'local');
  assert.equal(output.knowledgeFailure, 'service_error');
  assert.match(output.knowledgeNotice, /未经厂家逐项验证/);
  assert.deepEqual(
    output.evidence,
    supportKnowledge.filter((item) => item.topicId === displayQuery.topicId),
  );
  assert.ok(output.evidence.length);
  assert.equal(f.runtime.supportRetrieval?.status, 'available');
  assert.equal(f.runtime.supportRetrieval?.source, 'local');
  assert.ok(
    [...f.runtime.supportEvidence!.values()].every(
      (entry) =>
        entry.taskId === 'task' &&
        entry.messageId === 'current' &&
        entry.source === 'local',
    ),
  );
  assert.equal(f.runtime.knowledgeUnavailable, undefined);
  assert.equal(f.saved.length, 0);
});

void test('缺少主题、非法主题和销售检索不会读取整库售后作为回退', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 503 }),
  );
  const f = fixture();
  const noTopic = (await retrieveKnowledgeTool.execute(
    { query: '黑屏', category: 'support' },
    f.context,
    f.runtime,
  )) as RetrievalResult;
  assert.equal(noTopic.knowledgeFailure, 'service_error');
  assert.deepEqual(noTopic.evidence, []);
  assert.equal(f.runtime.supportRetrieval?.status, 'failed');
  assert.equal(f.runtime.supportEvidence?.size, 0);
  await assert.rejects(
    retrieveKnowledgeTool.execute(
      { ...displayQuery, topicId: 'unknown-topic' },
      f.context,
      f.runtime,
    ),
    /主题不存在/,
  );
  const sales = fixture();
  const salesResult = (await retrieveKnowledgeTool.execute(
    { query: '主板内存兼容', category: 'sales', topicId: displayQuery.topicId },
    sales.context,
    sales.runtime,
  )) as RetrievalResult;
  assert.deepEqual(salesResult.evidence, []);
  assert.equal(sales.runtime.knowledgeUnavailable, true);
  assert.equal(sales.runtime.supportRetrieval, undefined);
  assert.equal(sales.runtime.supportEvidence, undefined);
});

void test('向量服务正常但当前主题无匹配时不启用本地回退，不挪用其他主题', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  // 模拟向量检索语料缺失本主题；本地原文仍然存在，不能把无匹配当成服务故障。
  const original = [...knowledge];
  knowledge.splice(
    0,
    knowledge.length,
    ...original.filter(
      (item) => !('topicId' in item) || item.topicId !== displayQuery.topicId,
    ),
  );
  try {
    const f = fixture();
    const output = (await retrieveKnowledgeTool.execute(
      displayQuery,
      f.context,
      f.runtime,
    )) as RetrievalResult;
    assert.equal(output.knowledgeFailure, 'no_match');
    assert.deepEqual(output.evidence, []);
    assert.equal(output.knowledgeSource, 'none');
    assert.deepEqual(f.runtime.supportRetrieval, {
      taskId: 'task',
      messageId: 'current',
      status: 'empty',
      source: 'none',
    });
    assert.equal(f.runtime.supportEvidence?.size, 0);
  } finally {
    knowledge.splice(0, knowledge.length, ...original);
  }
});

void test('有效售后资料覆盖本次失败状态，保留同轮证据且拒绝跨消息或任务复用', async (t) => {
  t.mock.method(globalThis, 'fetch', embeddingFetch);
  const f = fixture();
  f.context.embeddingConfig = {};
  await retrieveKnowledgeTool.execute(
    { query: '黑屏', category: 'support' },
    f.context,
    f.runtime,
  );
  assert.equal(f.runtime.supportRetrieval?.status, 'failed');
  f.context.embeddingConfig = embeddingConfig;
  f.runtime.knowledgeUnavailable = true;
  const output = await retrieveKnowledgeTool.execute(
    displayQuery,
    f.context,
    f.runtime,
  );
  assert.ok(Array.isArray(output));
  assert.ok(output.every((item) => item.knowledgeSource === 'embedding'));
  assert.equal(f.runtime.supportRetrieval?.status, 'available');
  assert.equal(f.runtime.supportRetrieval?.source, 'embedding');
  const displayId = supportKnowledge.find(
    (item) => item.topicId === displayQuery.topicId,
  )!.id;
  const networkQuery = {
    query: 'WiFi断网',
    category: 'support',
    topicId: 'support-network',
  };
  await retrieveKnowledgeTool.execute(networkQuery, f.context, f.runtime);
  assert.equal(f.runtime.supportEvidence!.has(displayId), true);
  f.context.currentMessageId = 'next-message';
  await retrieveKnowledgeTool.execute(networkQuery, f.context, f.runtime);
  assert.equal(f.runtime.supportEvidence!.has(displayId), false);
  assert.ok(
    [...f.runtime.supportEvidence!.values()].every(
      (entry) => entry.messageId === 'next-message',
    ),
  );
  f.context.taskId = 'next-task';
  await retrieveKnowledgeTool.execute(displayQuery, f.context, f.runtime);
  assert.ok(
    [...f.runtime.supportEvidence!.values()].every(
      (entry) =>
        entry.taskId === 'next-task' && entry.messageId === 'next-message',
    ),
  );
});

void test('停止状态拒绝检索也记录stopped，取消不触发本地步骤回退', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw Error('服务不可用');
  });
  const stopped = fixture();
  stopped.runtime.draft.support = {
    status: 'stopped',
    symptom: '已经停止',
    history: [],
  };
  await assert.rejects(
    retrieveKnowledgeTool.execute(
      displayQuery,
      stopped.context,
      stopped.runtime,
    ),
    /已停止自行排查/,
  );
  assert.deepEqual(stopped.runtime.supportRetrieval, {
    taskId: 'task',
    messageId: 'current',
    status: 'stopped',
    source: 'none',
  });
  assert.equal(requests, 0);
  const cancelled = fixture();
  const controller = new AbortController();
  controller.abort();
  cancelled.context.signal = controller.signal;
  await assert.rejects(
    retrieveKnowledgeTool.execute(
      displayQuery,
      cancelled.context,
      cancelled.runtime,
    ),
    { name: 'AbortError' },
  );
  assert.equal(cancelled.runtime.supportEvidence?.size, 0);
  assert.equal(cancelled.saved.length, 0);
});
