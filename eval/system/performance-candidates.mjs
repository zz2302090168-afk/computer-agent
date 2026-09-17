import { traceEvent } from '../../backend/diagnostics/chat-trace.ts';
import { selectionRefusalReply } from '../../backend/agent/sales-reply.ts';
import { compactActionContext } from '../../backend/agent/action-context.ts';

export const conciseCompletionInstruction =
  '本轮工具已提供displayReply作为用户可见的事实正文。先检查当前用户请求是否还有未完成的操作：如有，继续执行必要工具，不得漏掉后续要求；如全部完成，不重复复述displayReply，仅用简短结束语收尾。用户另问的问题仍须依据事实完整回答。';

export function transformRequest(body, candidate) {
  if (candidate === 'unfused-selection' && body.tools?.length === 1 && body.tools[0].function.name === 'set_request_action') {
    const copy = structuredClone(body);
    delete copy.tools[0].function.parameters.properties.selectPlan;
    return copy;
  }
  if (candidate === 'action-context' && body.tools?.length === 1 && body.tools[0].function.name === 'set_request_action') {
    return { ...body, messages: body.messages.map((message, index) => index === 0 && message.role === 'system' && typeof message.content === 'string' ? { ...message, content: compactActionContext(message.content) } : message) };
  }
  if (
    candidate === 'single-action' &&
    body.tools?.length === 1 &&
    body.tools[0].function.name === 'set_request_action'
  )
    return { ...body, parallel_tool_calls: false };
  if (candidate !== 'concise-completion') return body;
  const lastUser = body.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  let hasReply = false;
  for (const message of body.messages.slice(lastUser + 1)) {
    if (message.role !== 'tool' || typeof message.content !== 'string')
      continue;
    try {
      const output = JSON.parse(message.content);
      if (selectionRefusalReply(output)) hasReply = false;
      else if (
        output.operation?.failed === false &&
        [
          'recommend_pc',
          'evaluate_plan',
          'explain_selection',
          'find_replacements',
          'replace_parts',
          'select_plan',
        ].includes(output.operation.tool) &&
        typeof output.data?.displayReply === 'string'
      )
        hasReply = true;
      else if (
        output.operation?.requirementsChanged ||
        output.operation?.partsChanged ||
        output.operation?.quoteChanged
      )
        hasReply = false;
    } catch {
      hasReply = false;
    }
  }
  return hasReply
    ? {
        ...body,
        messages: [
          ...body.messages,
          { role: 'system', content: conciseCompletionInstruction },
        ],
      }
    : body;
}

export function installPerformanceCandidate(candidate) {
  if (!['concise-completion', 'single-action', 'action-context', 'unfused-selection'].includes(candidate))
    throw Error('未知性能候选');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const address =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (
      !address.endsWith('/chat/completions') ||
      typeof options?.body !== 'string'
    )
      return originalFetch(url, options);
    const body = JSON.parse(options.body);
    const transformed = transformRequest(body, candidate);
    traceEvent('eval.performance_candidate', {
      candidate,
      applied: transformed !== body,
      parallelToolCalls: transformed.parallel_tool_calls,
      appendedInstruction:
        candidate === 'concise-completion' && transformed !== body
          ? conciseCompletionInstruction
          : undefined,
    });
    return originalFetch(url, {
      ...options,
      body: JSON.stringify(transformed),
    });
  };
}
