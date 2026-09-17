import { traceSync } from '../diagnostics/chat-trace';
import type {
  Catalog,
  PcTask,
  RecommendationResult,
  TaskSummary,
} from '../domain/types';
import {
  executeRegisteredTool,
  restrictedToolNames,
  toolDefinitions,
} from '../tools/registry';
import type { ToolContext, ToolRuntime } from '../tools/types';
import { requestToolActions } from '../tools/types';
import type { EmbeddingConfig } from '../rag/retrieve';
import { catalogModelContext } from '../rag/catalog-models';
import {
  chatCompletion,
  type ModelConfig,
  type ModelMessage,
} from './chat-model';
import { buildConversationPrompt } from './prompts';
import type { Draft } from './conversation-state';
import { toolProgress } from './progress';
import { renderSupportReply } from '../support/reply';
import { completedSalesReply, selectionRefusalReply } from './sales-reply';
import {
  updateReplacementContinuations,
  replacementLimitReply,
  type ReplacementContinuation,
} from './replacement-continuation';

export type { Draft } from './conversation-state';
export type ChatMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  consultPrebuiltId?: string;
  toolsUsed?: string[];
  pendingEvaluation?: { planIds: string[] };
  replacementQueries?: ModelMessage[];
  taskId?: string;
};
export type StateEvent = {
  type:
    | 'requirements'
    | 'parts'
    | 'plan'
    | 'evaluation'
    | 'task'
    | 'support'
    | 'monitor';
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

function availableToolDefinitions(runtime: ToolRuntime) {
  if (runtime.requestAction === 'pending')
    return toolDefinitions.filter(
      (tool) => tool.function.name === 'set_request_action',
    );
  const restrictedNames = restrictedToolNames(runtime);
  if (restrictedNames !== undefined)
    return toolDefinitions.filter((tool) =>
      restrictedNames.includes(tool.function.name),
    );
  const names = new Set([
    'update_requirements',
    'authorize_selection',
    'confirm_selections',
    'search_catalog',
    'retrieve_knowledge',
    'update_support',
  ]);
  if (runtime.exploration?.status === 'continue')
    names.add('finish_exploration');
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
    names.add('recommend_monitor');
    if (runtime.result.evaluation?.suggestions.some((item) => item.valid))
      names.add('apply_suggestion');
  }
  if (
    runtime.requestAction === 'recommend' &&
    runtime.requirementsTaskId !== runtime.task.id
  )
    return toolDefinitions.filter((tool) =>
      ['update_requirements', 'search_catalog', 'authorize_selection'].includes(
        tool.function.name,
      ),
    );
  if (
    runtime.exploration?.status === 'continue' &&
    (runtime.requestAction === undefined ||
      runtime.requestAction === 'recommend')
  ) {
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
  if (runtime.requestAction && runtime.requestAction !== 'recommend') {
    for (const name of ['recommend_pc', 'assemble_build', 'select_prebuilt'])
      names.delete(name);
    if (
      runtime.requestAction !== 'clarify' &&
      runtime.requestAction !== 'save_requirements'
    ) {
      names.delete('update_requirements');
      names.delete('authorize_selection');
    }
    if (
      runtime.requestAction === 'save_requirements' ||
      runtime.requestAction === 'clarify'
    )
      for (const name of [
        'confirm_selections',
        'select_plan',
        'replace_parts',
        'apply_suggestion',
        'update_support',
        'evaluate_plan',
        'recommend_monitor',
      ])
        names.delete(name);
  }
  return toolDefinitions.filter((tool) => names.has(tool.function.name));
}

export function availableTools(runtime: ToolRuntime, _taskCount?: number) {
  return availableToolDefinitions(runtime).map((tool) => {
    const request = runtime.supportRequest;
    if (
      tool.function.name !== 'update_support' ||
      !request ||
      runtime.requestAction !== 'update_support' ||
      request.taskId !== runtime.task.id
    )
      return tool;
    // 本轮动作已经声明，只收窄模型可提交的参数；执行端仍独立核验授权。
    const definition = structuredClone(tool);
    const parameters = definition.function.parameters;
    const properties = parameters.properties as Record<string, unknown>;
    properties.action = { type: 'string', enum: [request.action] };
    return definition;
  });
}

function requestedToolPending(runtime: ToolRuntime) {
  return (
    (runtime.knowledgeOnly === true && !runtime.knowledgeAnswerReady) ||
    (runtime.consultPrebuiltId !== undefined &&
      !runtime.consultPrebuiltQueried) ||
    (requestToolActions.some((name) => name === runtime.requestAction) &&
      !runtime.facts.some((fact) => fact.tool === runtime.requestAction))
  );
}

function userMessageContent(message: ChatMessage) {
  return (
    (message.id ? `[messageId=${message.id}] ` : '') +
    message.content +
    (message.consultPrebuiltId
      ? `\n[整机商品咨询附件：${JSON.stringify({ prebuiltId: message.consultPrebuiltId })}。此 ID 仅标识咨询商品，不代表选定、替换或购买确认；先用 search_catalog(kind=prebuilt, prebuiltId=该ID)读取当前商品。ID 仅用于工具定位，不出现在面向用户的回复中。]`
      : '')
  );
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
        `\n本轮结构化动作：${runtime.requestAction ?? '未记录'}。recommend 必须先保存用户当前及历史明确需求，齐全后同轮推荐；clarify 保存已有字段并追问缺失预算用途；save_requirements 必须记录需求，不生成；具体工具动作必须实际调用同名工具，失败时依据返回问题解释或修正，不可用口头答应代替执行；other 仅无需工具的回答或澄清。不得从已有预算或自己的回复推导生成授权。` +
        (runtime.knowledgeOnly
          ? `\n本轮是纯知识问答：先retrieve_knowledge，再answer_knowledge选取本轮证据；资料不足时coverage=unsupported和空ID数组。如已完成证据答复仅简短收尾，不必重复正文。证据答复完成=${runtime.knowledgeAnswerReady === true}。`
          : '') +
        `\n本轮已声明售后动作：${JSON.stringify(runtime.supportRequest ?? null)}。update_support.action必须与已声明action一致。` +
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
        '。已有该类别商品时，不得把一次过滤后空结果说成整个类别没有商品。' +
        (runtime.requestAction === 'find_replacements' ||
        runtime.requestAction === 'search_catalog'
          ? catalogModelContext(context.catalog.parts, currentUser.content)
          : '') +
        '\n本轮知识检索配置：' +
        (context.embeddingConfig?.key &&
        context.embeddingConfig?.base &&
        context.embeddingConfig?.model
          ? '已配置，但必须实际检索成功且证据支持，才能给出知识性具体结论。'
          : '不可用。售前知识咨询只解释工具返回的数据库已有规格或追问需求，并说明知识检索不可用；不得补充未记录的性能或规格。售后仍须retrieve_knowledge，故障主题明确时提供topicId以读取同主题本地资料；无适用资料时只选questionId澄清。普通配机无需插入此提示。'),
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
            message.role === 'user'
              ? userMessageContent(message)
              : message.content,
        },
      ]),
    {
      role: 'user',
      content: userMessageContent(currentUser),
    },
  ];
}

/**
 * 单次模型循环同时承担语义理解和工具选择，不增加独立意图分类调用。
 * 每轮按本次对话的结构化状态开放工具，持续保留当前页面的需求与工具事实。
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
  consultPrebuiltId?: string,
  onText?: (text: string) => void,
) {
  if (!state.task || !state.currentTaskId) throw Error('当前任务上下文缺失');
  if (
    consultPrebuiltId !== undefined &&
    !catalog.prebuilts.some((pc) => pc.id === consultPrebuiltId)
  )
    throw Error('咨询的组装整机已不在当前商品目录，请返回目录重新选择');
  const initialTaskId = state.currentTaskId,
    currentUser: ChatMessage = {
      id: messageId,
      role: 'user',
      content: message,
      ...(consultPrebuiltId !== undefined ? { consultPrebuiltId } : {}),
      taskId: initialTaskId,
    };
  const runtime: ToolRuntime = {
    requestAction: 'pending',
    ...(consultPrebuiltId !== undefined
      ? { consultPrebuiltId, consultPrebuiltQueried: false }
      : {}),
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
  let resumedEvaluation: unknown;
  // 只解析程序保存的评估追问的编号回答，不从助手措辞猜测意图。
  const prior = state.messages
    .filter((entry) => entry.taskId === initialTaskId)
    .at(-1);
  const pending =
    prior?.role === 'assistant' ? prior.pendingEvaluation : undefined;
  const ordinal = /^(?:方案)?\s*([1-9]\d*)\s*$/u.exec(message.trim());
  if (!consultPrebuiltId && pending && ordinal) {
    runtime.requestAction = 'evaluate_plan';
    runtime.readOnlyEvaluationTurn = true;
    const index = Number(ordinal[1]) - 1;
    const plans = runtime.result?.plans ?? [];
    if (
      pending.planIds.length !== plans.length ||
      pending.planIds.some((id, i) => id !== plans[i]?.id)
    )
      throw Error('待评估方案已变化，请重新指定要评估的方案');
    if (!pending.planIds[index])
      throw Error('评估方案编号无效，请选择已有方案编号');
    const evaluation = await executeRegisteredTool(
      'evaluate_plan',
      { planId: pending.planIds[index] },
      context,
      runtime,
    );
    runtime.toolsUsed.push('读取待评估对象');
    runtime.pendingEvaluation = undefined;
    resumedEvaluation = evaluation;
  }
  const messages = modelContext(runtime, context, currentUser, state.messages);
  let answer = '';
  let supportAnswer: string | undefined;
  let salesAnswer = completedSalesReply(resumedEvaluation);
  let selectionRefusal: string | undefined;
  let selectionFollowup = false;
  if (resumedEvaluation)
    messages.push({
      role: 'system',
      content: `本轮编号仅指定评估对象；程序已执行evaluate_plan，结果：${JSON.stringify(resumedEvaluation)}。本轮禁止选定、购买确认或修改配置。请按结果回答。`,
    });
  const replacementQueries: ModelMessage[] = [];
  let completionRepairs = 0;
  let requireAction = false;
  let proposedSelection: ModelMessage | undefined;
  const replacementContinuations: ReplacementContinuation[] = [];

  const maxRounds = 16;
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    onProgress?.({
      scope: 'main',
      label: round ? '根据执行结果决定下一步' : '理解当前需求',
      status: 'running',
    });
    const hasUnfinishedWork = () => {
      const requirementsRecorded =
        runtime.requirementsTaskId === context.taskId;
      const unfinishedRequest =
        runtime.requestAction === 'pending' ||
        requestedToolPending(runtime) ||
        (['save_requirements', 'clarify'].includes(
          runtime.requestAction ?? '',
        ) &&
          !requirementsRecorded) ||
        (runtime.requestAction === 'recommend' &&
          (!requirementsRecorded ||
            (runtime.draft.budget &&
              runtime.draft.purpose &&
              (runtime.configurationTaskId !== context.taskId ||
                !['ready', 'reference', 'blocked'].includes(
                  runtime.exploration?.status ?? '',
                )))));
      const unfinishedExploration =
        runtime.exploration?.status === 'continue' && round < maxRounds - 1;
      return unfinishedRequest || unfinishedExploration;
    };
    let streamedText = '';
    const canStream =
      !hasUnfinishedWork() &&
      !(
        runtime.requestAction === 'recommend' &&
        (!runtime.draft.budget || !runtime.draft.purpose)
      ) &&
      !runtime.knowledgeUnavailable &&
      !runtime.sessionLifecycleQuestion &&
      !salesAnswer &&
      !replacementContinuations.length &&
      !selectionRefusal &&
      !renderSupportReply(runtime, context);
    const tools = availableTools(runtime, context.tasks.length);
    let response: ModelMessage;
    try {
      if (replacementContinuations.length && round >= maxRounds - 1) {
        // 自动查询也消耗同一轮数预算，最后一轮只做有据收尾。
        salesAnswer = [salesAnswer, replacementLimitReply]
          .filter(Boolean)
          .join('\n\n');
        replacementContinuations.length = 0;
        response = { role: 'assistant', content: '' };
      } else if (replacementContinuations.length) {
        const args = replacementContinuations.shift()!;
        response = traceSync('replacement.continue', { round, args }, () => ({
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            {
              id: `replacement-page-${crypto.randomUUID()}`,
              type: 'function' as const,
              function: {
                name: 'find_replacements',
                arguments: JSON.stringify(args),
              },
            },
          ],
        }));
      } else if (proposedSelection) {
        response = proposedSelection;
        proposedSelection = undefined;
      } else
        response = await chatCompletion(
          config,
          messages,
          tools,
          (requireAction ||
            runtime.requestAction === 'pending' ||
            requestedToolPending(runtime)) &&
            round < maxRounds - 1
            ? 'required'
            : conversationToolChoice(runtime.exploration, round, maxRounds),
          signal,
          canStream
            ? (text) => {
                streamedText += text;
                onText?.(streamedText);
              }
            : undefined,
        );
    } catch (cause) {
      signal?.throwIfAborted();
      throw cause;
    }
    requireAction = false;
    messages.push(response);
    if (!response.tool_calls?.length) {
      const content = response.content?.trim() ?? '';
      if (hasUnfinishedWork()) {
        if (completionRepairs >= 2 || round >= maxRounds - 1)
          throw Error(
            '模型尚未执行完配置操作，请重试；本次对话已记录的需求仍保留',
          );
        completionRepairs++;
        requireAction = true;
        messages.push({
          role: 'system',
          content: `本轮结构化动作或必要操作尚未完成，纯文本回复未交付。当前动作=${runtime.requestAction}。${runtime.knowledgeOnly ? '纯知识问答检索后必须answer_knowledge选择本轮证据，资料不足也用该工具明确unsupported，不得以自由文字代替。' : ''}动作未记录时先调用set_request_action。clarify也必须先调用update_requirements保存全部已知无冲突需求，没有已知需求时传空对象；局部冲突不能丢弃其他已知信息。具体工具动作必须执行对应工具；只根据执行结果说明成功或具体阻碍。recommend先保存需求，预算用途齐全后同轮调用recommend_pc；工具报告本轮无法继续时用finish_exploration记录具体阻碍。咨询、售后、局部修改、暂不生成不得强制配机。不从助手措辞推导用户意图。`,
        });
        continue;
      }
      // 配机动作尚缺核心需求时只能追问，目录查询不能作为方案交付凭证。
      if (
        runtime.requestAction === 'recommend' &&
        (!runtime.draft.budget || !runtime.draft.purpose)
      ) {
        const missing = [
          !runtime.draft.budget ? '主机预算' : '',
          !runtime.draft.purpose ? '主要用途' : '',
        ]
          .filter(Boolean)
          .join('和');
        answer = `还需要确认${missing}，才能生成并在右侧展示完整配置。请告诉我${missing}。`;
        break;
      }
      // 结束依据用户动作和工具结果，不检查助手用了哪些承诺措辞。
      supportAnswer = renderSupportReply(runtime, context);
      const salesOrRefusal = selectionRefusal
        ? [
            selectionRefusal,
            selectionFollowup ? (salesAnswer ?? content) : undefined,
          ]
            .filter(Boolean)
            .join('\n\n')
        : salesAnswer;
      answer = supportAnswer ?? salesOrRefusal ?? content;
      if (runtime.sessionLifecycleQuestion) {
        const sessionReply =
          '聊天、需求、方案、确认和售后进度仅保留在本次页面会话中。站内进入商品目录再返回时会保留，进行中的输出和配置生成会继续；刷新页面（包括在目录页刷新）、关闭页面或开始新会话都会清空，之后无法恢复。';
        answer = [answer, sessionReply].filter(Boolean).join('\n\n');
      }
      if (!answer) throw Error('模型没有返回最终回复');
      break;
    }
    if (streamedText) onText?.('');
    const toolMessages: ModelMessage[] = [];
    for (const [callIndex, call] of response.tool_calls.entries()) {
      signal?.throwIfAborted();
      onProgress?.({
        scope: 'main',
        label: toolProgress[call.function.name] ?? '处理当前任务',
        status: 'running',
      });
      let output: unknown;
      try {
        if (callIndex >= 10)
          throw Error('单轮最多执行10次工具调用，请下一轮继续');
        if (
          !availableTools(runtime, context.tasks.length).some(
            (tool) => tool.function.name === call.function.name,
          )
        )
          throw Error(`当前状态不可调用工具：${call.function.name}`);
        const args = JSON.parse(call.function.arguments || '{}');
        const toolOutput = await executeRegisteredTool(
          call.function.name,
          args,
          context,
          runtime,
        );
        output = toolOutput;
        // 参数可与动作一起提出，但执行仍走下一轮的工具权限和原工具审核。
        // 不提前结束：选定后的解释、查询及会话补问继续由模型处理。
        if (
          call.function.name === 'set_request_action' &&
          response.tool_calls.length === 1 &&
          !toolOutput.operation.failed &&
          args.action === 'select_plan' &&
          args.selectPlan !== undefined
        )
          proposedSelection = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `proposed-selection-${crypto.randomUUID()}`,
                type: 'function',
                function: {
                  name: 'select_plan',
                  arguments: JSON.stringify(args.selectPlan),
                },
              },
            ],
          };
        if (
          toolOutput.operation.requirementsChanged ||
          toolOutput.operation.partsChanged ||
          toolOutput.operation.quoteChanged
        )
          replacementContinuations.length = 0;
        updateReplacementContinuations(
          replacementContinuations,
          toolOutput,
          args,
        );
        if (
          runtime.knowledgeOnly &&
          call.function.name === 'retrieve_knowledge' &&
          !toolOutput.operation.failed
        )
          salesAnswer = undefined;
        const refusal = selectionRefusalReply(toolOutput);
        const reply = completedSalesReply(toolOutput);
        if (refusal) {
          selectionRefusal = refusal;
          selectionFollowup = false;
          salesAnswer = undefined;
        } else if (!toolOutput.operation.failed) {
          if (call.function.name === 'select_plan') {
            selectionRefusal = undefined;
            selectionFollowup = false;
          } else if (
            selectionRefusal &&
            (reply ||
              ['search_catalog', 'retrieve_knowledge'].includes(
                call.function.name,
              ))
          ) {
            selectionFollowup = true;
            if (!reply) salesAnswer = undefined;
          }
        }
        if (reply) salesAnswer = reply;
        else if (
          toolOutput.operation.requirementsChanged ||
          toolOutput.operation.partsChanged ||
          toolOutput.operation.quoteChanged
        )
          salesAnswer = undefined;
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
      toolMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: traceSync(
          'context.tool_result',
          { tool: call.function.name },
          () => JSON.stringify(output),
        ),
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
  }

  if (!answer) throw Error('模型在最大轮数内没有返回最终回复');
  // 显示工具已确认的降级状态；这里不判断意图或生成知识性结论。
  if (
    !supportAnswer &&
    runtime.knowledgeUnavailable &&
    !answer.includes('知识检索不可用')
  )
    answer =
      (runtime.knowledgeOnly
        ? '知识检索不可用。\n\n'
        : '知识检索不可用，以下仅依据数据库已有规格与程序审核结果。\n\n') +
      answer;
  const assistant: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: answer,
    toolsUsed: [...new Set(runtime.toolsUsed)],
    ...(runtime.pendingEvaluation
      ? { pendingEvaluation: runtime.pendingEvaluation }
      : {}),
    ...(replacementQueries.length ? { replacementQueries } : {}),
    taskId: context.taskId,
  };
  return {
    draft: runtime.draft,
    result: runtime.result,
    taskId: context.taskId,
    messages: [
      ...state.messages,
      { ...currentUser, taskId: context.taskId },
      assistant,
    ].slice(-40),
    facts: runtime.facts,
  };
}
