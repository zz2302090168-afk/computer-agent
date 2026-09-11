import type {
  Catalog,
  PcTask,
  RecommendationResult,
  TaskSummary,
} from '../domain/types';
import { executeRegisteredTool, toolDefinitions } from '../tools/registry';
import type { ToolContext, ToolRuntime } from '../tools/types';
import type { EmbeddingConfig } from '../rag/retrieve';
import {
  chatCompletion,
  type ModelConfig,
  type ModelMessage,
} from './chat-model';
import { buildConversationPrompt } from './prompts';
import type { Draft } from './conversation-state';
import { toolProgress } from './progress';

export type { Draft } from './conversation-state';
export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  replacementQueries?: ModelMessage[];
  taskId?: string;
};
export type StateEvent = {
  type: 'requirements' | 'parts' | 'plan' | 'evaluation' | 'task' | 'support';
  taskId: string;
  version: number;
};
export type ChatState = {
  draft: Draft;
  messages: ChatMessage[];
  result: RecommendationResult | null;
  task?: PcTask;
  tasks?: TaskSummary[];
  currentTaskId?: string;
  events?: StateEvent[];
  modelConfigured?: boolean;
};

export function conversationToolChoice(
  exploration: ToolRuntime['exploration'],
  round: number,
  maxRounds: number,
): 'auto' | 'required' | 'none' {
  // 最后一轮必须留出纯文本收尾的机会：继续强制工具调用会让模型无法结束，
  // 整轮以“没有返回最终回复”失败，用户侧表现为一直卡住。
  if (round >= maxRounds - 1) return 'none';
  return exploration?.status === 'continue' ? 'required' : 'auto';
}

export function availableTools(runtime: ToolRuntime, taskCount: number) {
  const names = new Set([
    'update_requirements',
    'authorize_selection',
    'confirm_selections',
    'search_catalog',
    'retrieve_knowledge',
    'update_support',
    'create_task',
    'reset_current_task',
    'undo_last_change',
  ]);
  if (runtime.exploration?.status === 'continue')
    names.add('finish_exploration');
  if (taskCount > 1) names.add('switch_task');
  if (runtime.draft.budget && runtime.draft.purpose) {
    names.add('recommend_pc');
    if (
      runtime.result?.plans.length ||
      runtime.draft.preferCheaper ||
      runtime.draft.preferExpensive
    ) {
      if (runtime.draft.mode !== 'prebuilt') names.add('assemble_build');
      if (runtime.draft.mode !== 'diy') names.add('select_prebuilt');
    }
  }
  if (runtime.result?.plans.length) {
    names.add('select_plan');
    names.add('find_replacements');
    names.add('explain_selection');
    names.add('replace_parts');
    names.add('evaluate_plan');
    if (runtime.result.evaluation?.suggestions.some((item) => item.valid))
      names.add('apply_suggestion');
  }
  if (runtime.exploration?.status === 'continue') {
    const continuation = runtime.recommendationAttemptKeys?.size
      ? new Set(['finish_exploration'])
      : runtime.candidateSubmissionKeys?.size
        ? new Set([
            'search_catalog',
            'assemble_build',
            'select_prebuilt',
            'finish_exploration',
          ])
        : new Set(['recommend_pc']);
    return toolDefinitions.filter((tool) =>
      continuation.has(tool.function.name),
    );
  }
  return toolDefinitions.filter((tool) => names.has(tool.function.name));
}

function modelContext(
  runtime: ToolRuntime,
  context: ToolContext,
  currentUser: ChatMessage,
  history: ChatMessage[],
): ModelMessage[] {
  return [
    {
      role: 'system',
      content:
        buildConversationPrompt({
          taskId: context.taskId,
          currentMessageId: context.currentMessageId,
          draft: runtime.draft,
          result: runtime.result,
          tasks: context.tasks,
          facts: runtime.facts,
          exploration: runtime.exploration,
        }) +
        '\n当前数据库分类数量（全目录，不带型号或颜色过滤）：' +
        JSON.stringify(
          context.catalog.parts.reduce<Record<string, number>>(
            (counts, part) => {
              counts[part.category] = (counts[part.category] ?? 0) + 1;
              return counts;
            },
            {},
          ),
        ) +
        '。已有该类别商品时，不得把一次过滤后空结果说成整个类别没有商品。',
    },
    ...history
      .filter((message) => !message.taskId || message.taskId === context.taskId)
      .slice(-16)
      .flatMap((message): ModelMessage[] => [
        ...(message.role === 'assistant'
          ? (message.replacementQueries ?? [])
          : []),
        {
          role: message.role,
          content:
            message.role === 'user' && message.id
              ? `[messageId=${message.id}] ${message.content}`
              : message.content,
        },
      ]),
    {
      role: 'user',
      content: `[messageId=${currentUser.id}] ${currentUser.content}`,
    },
  ];
}

/**
 * 单次模型循环同时承担语义理解和工具选择，不增加独立意图分类调用。
 * 每轮按结构化任务状态开放工具；任务切换后立即重建上下文，旧工具结果不会注入新任务。
 */
export async function runConversation(
  config: ModelConfig,
  state: ChatState,
  message: string,
  messageId: string,
  catalog: Catalog,
  reloadCatalog: () => Promise<Catalog>,
  onUpdate: NonNullable<ToolContext['onUpdate']>,
  sessionId: string,
  onTaskChange: ToolContext['onTaskChange'],
  onProgress?: ToolContext['onProgress'],
  signal?: AbortSignal,
  embeddingConfig?: EmbeddingConfig,
) {
  if (!state.task || !state.currentTaskId) throw Error('当前任务上下文缺失');
  const initialTaskId = state.currentTaskId,
    currentUser: ChatMessage = {
      id: messageId,
      role: 'user',
      content: message,
      taskId: initialTaskId,
    };
  const runtime: ToolRuntime = {
    draft: state.draft,
    result: state.result,
    approvedPartIds: new Set(),
    toolsUsed: [],
    toolErrors: [],
    task: state.task,
    contextChanged: false,
    facts: [],
  };
  const context: ToolContext = {
    embeddingConfig,
    modelConfig: config,
    signal,
    onProgress,
    sessionId,
    taskId: initialTaskId,
    currentMessageId: messageId,
    messages: [...state.messages, currentUser],
    tasks: state.tasks ?? [],
    catalog,
    reloadCatalog,
    onUpdate,
    onTaskChange,
  };
  let messages = modelContext(runtime, context, currentUser, state.messages),
    answer = '';
  let replacementQueries: ModelMessage[] = [];

  const maxRounds = 16;
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    onProgress?.({
      scope: 'main',
      label: round ? '根据执行结果决定下一步' : '理解当前需求',
      status: 'running',
    });
    const tools = availableTools(runtime, context.tasks.length);
    let response: ModelMessage;
    try {
      response = await chatCompletion(
        config,
        messages,
        tools,
        conversationToolChoice(runtime.exploration, round, maxRounds),
        signal,
      );
    } catch (cause) {
      signal?.throwIfAborted();
      throw cause;
    }
    messages.push(response);
    if (!response.tool_calls?.length) {
      // 中间轮擅自结束仍是错误；但最后一轮已由程序强制 tool_choice=none，
      // 此时只能接受如实说明阻碍的文本收尾，否则整轮必然失败。
      if (runtime.exploration?.status === 'continue' && round < maxRounds - 1)
        throw Error('模型在配置探索完成前结束了工具调用');
      answer = response.content?.trim() ?? '';
      if (!answer) throw Error('模型没有返回最终回复');
      break;
    }
    const toolMessages: ModelMessage[] = [];
    for (const [callIndex, call] of response.tool_calls.entries()) {
      signal?.throwIfAborted();
      onProgress?.({
        scope: 'main',
        label: toolProgress[call.function.name] ?? '处理当前任务',
        status: 'running',
      });
      let output: unknown;
      if (runtime.contextChanged)
        output = {
          error: '任务上下文已经切换，请在下一轮重新调用',
          operation: {
            tool: call.function.name,
            requirementsChanged: false,
            partsChanged: false,
            quoteChanged: false,
            hasPendingItems: false,
            failed: true,
          },
        };
      else {
        try {
          if (callIndex >= 10)
            throw Error('单轮最多执行10次工具调用，请下一轮继续');
          if (!tools.some((tool) => tool.function.name === call.function.name))
            throw Error(`当前状态不可调用工具：${call.function.name}`);
          const toolOutput = await executeRegisteredTool(
            call.function.name,
            JSON.parse(call.function.arguments || '{}'),
            context,
            runtime,
          );
          output = toolOutput;
        } catch (cause) {
          const error =
            cause instanceof Error ? cause.message : '工具参数不是有效 JSON';
          runtime.toolErrors.push(error);
          output = {
            error,
            operation: {
              tool: call.function.name,
              requirementsChanged: false,
              partsChanged: false,
              quoteChanged: false,
              hasPendingItems:
                runtime.result?.plans.some(
                  (plan) => plan.validation.status === 'unknown',
                ) ?? false,
              failed: true,
            },
          };
        }
      }
      toolMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
    messages.push(...toolMessages);
    // 只读查询不改配置，但跨轮仍需保留过滤条件和候选事实，不能只靠助手摘要。
    const queryCalls = response.tool_calls.filter(
      (call) => call.function.name === 'find_replacements',
    );
    if (queryCalls.length)
      replacementQueries.push(
        { ...response, content: null, tool_calls: queryCalls },
        ...toolMessages.filter((entry) =>
          queryCalls.some((call) => call.id === entry.tool_call_id),
        ),
      );
    // 工具改变需求后同步刷新系统状态，避免模型继续认为用途尚未记录。
    messages[0] = modelContext(runtime, context, currentUser, [])[0];
    if (runtime.contextChanged) {
      replacementQueries = [];
      runtime.contextChanged = false;
      runtime.supportKnowledgeIds = undefined;
      currentUser.taskId = context.taskId;
      messages = [
        ...modelContext(runtime, context, currentUser, []),
        response,
        ...toolMessages,
      ];
    }
  }

  if (!answer) throw Error('模型在最大轮数内没有返回最终回复');
  const base = context.taskId === initialTaskId ? state.messages : [],
    assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: answer,
      toolsUsed: [...new Set(runtime.toolsUsed)],
      ...(replacementQueries.length ? { replacementQueries } : {}),
      taskId: context.taskId,
    };
  return {
    draft: runtime.draft,
    result: runtime.result,
    taskId: context.taskId,
    messages: [
      ...base,
      { ...currentUser, taskId: context.taskId },
      assistant,
    ].slice(-40),
    facts: runtime.facts,
  };
}
