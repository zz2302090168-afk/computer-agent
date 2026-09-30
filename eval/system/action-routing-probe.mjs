import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { parse } from 'dotenv';
import { chatCompletion } from '../../backend/agent/chat-model.ts';
import { compactActionContext } from '../../backend/agent/action-context.ts';
import { setRequestActionTool } from '../../backend/tools/requirements/action.ts';
import { createChatTrace } from '../../backend/diagnostics/chat-trace.ts';

const root = process.argv[2];
const target = `${root}/action-routing-probe`;
if (existsSync(`${target}/results.json`)) throw Error('不能覆盖已有探测');
mkdirSync(target, { recursive: true });
const source = readFileSync(`${root}/action-context-control-a/BRAND-MSI-0.trace.jsonl`, 'utf8').trim().split('\n').map(JSON.parse).find(e => e.event === 'model.start').data.input.messages;
const env = parse(readFileSync(process.env.EVAL_ENV_FILE ?? 'C:/Users/User/Desktop/电脑agent/.env.local'));
const config = { key: env.MODEL_API_KEY, base: env.MODEL_BASE_URL, model: env.MODEL_NAME };
const cases = [
  ['knowledge', 'DDR5是什么意思？只解释概念，不要配置方案。', { action: 'retrieve_knowledge', knowledgeOnly: true }],
  ['explain', '只解释第二套为什么选这块主板，不选定、不确认、不修改。', { action: 'explain_selection' }],
  ['save', '预算9000元用来打游戏，这次只记录需求，暂时不要生成。', { action: 'save_requirements' }],
  ['recommend', '预算9000元用来打游戏，请重新给我配一套主机。', { action: 'recommend' }],
  ['stop', '电脑电源已经冒烟，我已拔掉电源，接下来怎么办？', { action: 'update_support', supportAction: 'stop' }],
  ['support-entry', '如何联系人工客服？我只是了解入口，暂时不要转人工。', { action: 'other', otherTopic: 'support' }],
  ['replace', '把当前方案的显卡实际换成微星RTX4060，其他配件不动。', { action: 'replace_parts' }],
  ['clarify', '想配一台电脑，预算和用途还没确定，先问我需要提供什么。', { action: 'clarify' }],
];
const results = [];
for (const [id, query, expected] of cases) {
  if (typeof id !== 'string' || typeof query !== 'string' || !expected || typeof expected !== 'object') throw Error('探测用例格式无效');
  let system = source[0].content;
  if (id === 'clarify') {
    system = system.replace(/当前结构化需求：([^\n]+)/u, (_, json) => {
      const draft = JSON.parse(json); draft.budget = 0; draft.purpose = ''; return `当前结构化需求：${JSON.stringify(draft)}`;
    }).replace(/当前方案：[^\n]+/u, '当前方案：null');
  }
  const messageId = system.match(/当前用户消息 ID：([^\n]+)/u)[1];
  const trace = createChatTrace({ experiment: 'action-routing-probe', id, expected }, target);
  let result;
  try {
    result = await trace.run(() => chatCompletion(config, [{ role: 'system', content: compactActionContext(system) }, { role: 'user', content: `[messageId=${messageId}] ${query}` }], [setRequestActionTool.definition], 'required'));
    const calls = result.tool_calls ?? [];
    const passed = calls.length > 0 && calls.every(call => {
      const args = JSON.parse(call.function.arguments);
      return call.function.name === 'set_request_action' && args.sourceMessageId === messageId && Object.entries(expected).every(([k, v]) => args[k] === v);
    });
    results.push({ id, query, expected, passed, result, trace: trace.file });
  } catch (error) { results.push({ id, query, expected, passed: false, error: error.message, trace: trace.file }); }
  console.log(id, results.at(-1).passed);
  writeFileSync(`${target}/results.json`, JSON.stringify(results, null, 2));
}
