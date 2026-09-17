import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actionContextMessages,
  compactActionContext,
} from '../agent/action-context';
import { buildConversationPrompt } from '../agent/prompts';
import { fixture } from './pc-fixture';
import { setRequestActionTool } from '../tools/requirements/action';
import { searchCatalogTool } from '../tools/catalog/search';
import type { ModelMessage } from '../agent/chat-model';

void test('动作阶段压缩静态说明但逐字保留用户、历史、需求和方案状态', () => {
  const f = fixture();
  const full = buildConversationPrompt({
    taskId: 'task',
    currentMessageId: 'current',
    draft: f.runtime.draft,
    result: f.runtime.result,
    tasks: [],
    facts: [],
  });
  const history: ModelMessage = {
    role: 'user',
    content: '之前只查白色，不要替换。',
  };
  const user: ModelMessage = {
    role: 'user',
    content: '[messageId=current] 先选第二套，再解释主板，不确认。',
  };
  const messages: ModelMessage[] = [
    { role: 'system', content: full },
    history,
    user,
  ];
  const shortened = actionContextMessages(messages, [
    setRequestActionTool.definition,
  ]);
  assert.ok(shortened[0].content!.length < full.length);
  assert.equal(shortened[1], history);
  assert.equal(shortened[2], user);
  const start = full.indexOf('\n当前用户消息 ID：');
  const end = full.indexOf('\n\n', full.indexOf('\n本轮已执行操作事实：'));
  assert.ok(shortened[0].content!.endsWith(full.slice(start, end)));
  assert.equal(messages[0].content, full);
  assert.equal(
    compactActionContext(shortened[0].content!),
    shortened[0].content,
  );
});

void test('业务执行阶段及非标准提示保持原样，不裁剪审核规则', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: '独立测试或其他模型提示，没有标准状态分界。' },
    { role: 'user', content: '当前请求' },
  ];
  assert.equal(
    actionContextMessages(messages, [searchCatalogTool.definition]),
    messages,
  );
  assert.equal(
    actionContextMessages(messages, [
      setRequestActionTool.definition,
      searchCatalogTool.definition,
    ]),
    messages,
  );
  assert.equal(
    actionContextMessages(messages, [setRequestActionTool.definition])[0]
      .content,
    messages[0].content,
  );
});
