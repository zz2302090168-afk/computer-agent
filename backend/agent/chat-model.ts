import { traceEvent, traceOperation } from '../diagnostics/chat-trace';
import { readLines } from '../../lib/stream';

export type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};
export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export type ModelConfig = { key?: string; base?: string; model?: string };
async function requestCompletion(
  config: ModelConfig,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  toolChoice: 'auto' | 'required' | 'none' = 'auto',
  signal?: AbortSignal,
  onText?: (text: string) => void,
) {
  if (!config.key || !config.base || !config.model)
    throw Error('模型配置缺失，请在服务端配置 API。');
  const url = new URL(config.base);
  if (url.protocol !== 'https:') throw Error('模型地址必须使用 HTTPS');
  const response = await fetch(
    url.href.replace(/\/$/, '') + '/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(90000),
        ...(signal ? [signal] : []),
      ]),
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        tool_choice: toolChoice,
        temperature: 0.2,
        max_tokens: 1600,
        stream: true,
        stream_options: { include_usage: true },
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Error(`模型连接失败（HTTP ${response.status}），请稍后重试。`);
  }
  if (!response.body) throw Error('模型没有返回消息流');
  const calls = new Map<number, ToolCall>();
  let content = '',
    finished = false,
    truncated = false;
  let eventData: string[] = [];
  const consume = () => {
    const payload = eventData.join('\n');
    eventData = [];
    if (payload === '[DONE]') return true;
    if (!payload) return false;
    const event = JSON.parse(payload) as {
      usage?: unknown;
      error?: unknown;
      choices?: {
        index: number;
        finish_reason?: string | null;
        delta?: {
          content?: string;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
    };
    if (event.usage)
      traceEvent('model.usage', { model: config.model, usage: event.usage });
    if (event.error) throw Error('模型流返回错误，请重试');
    const choice = event.choices?.find((item) => item.index === 0);
    if (!choice) return false;
    if (choice.finish_reason) {
      finished = true;
      truncated = !['stop', 'tool_calls'].includes(choice.finish_reason);
    }
    const text = choice.delta?.content;
    if (text) {
      content += text;
      onText?.(text);
    }
    for (const delta of choice.delta?.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? {
        id: '',
        type: 'function',
        function: { name: '', arguments: '' },
      };
      if (delta.id) call.id = delta.id;
      call.function.name += delta.function?.name ?? '';
      call.function.arguments += delta.function?.arguments ?? '';
      calls.set(delta.index, call);
    }
    return false;
  };
  for await (const line of readLines(response.body)) {
    if (!line) {
      if (consume()) break;
    } else if (line.startsWith('data:'))
      eventData.push(line.slice(5).trimStart());
  }
  if (eventData.length) consume();
  if (!finished || truncated) throw Error('模型消息流未完整结束，请重试');
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call);
  if (toolCalls.some((call) => !call.id || !call.function.name))
    throw Error('模型工具调用不完整');
  return {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  } satisfies ModelMessage;
}

export const chatCompletion = (...args: Parameters<typeof requestCompletion>) =>
  traceOperation(
    'model',
    {
      model: args[0].model,
      messages: args[1],
      tools: args[2].map((tool) => tool.function.name),
      toolChoice: args[3] ?? 'auto',
    },
    () => requestCompletion(...args),
  );
