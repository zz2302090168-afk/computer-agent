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
  directTaskInvocation,
  planningToolContracts,
} from '../tools/registry';
import type { ToolContext, ToolRuntime } from '../tools/types';
import { requestToolActions, ToolExecutionError } from '../tools/types';
import { canReplan } from '../tools/replan';
import { toolMetadata } from '../tools/metadata';
import { canCompleteDirectQuery } from './query-completion';
import { tryJevRoute } from './jev-router';
import { selectToolWithJev } from './jev-tool-selector';
import { catalogPaginationHint, recordCatalogPage } from './catalog-pagination';
import {
  prepareParallelReads,
  consumePreparedRead,
  type PreparedRead,
} from './parallel-reads';
import type { EmbeddingConfig } from '../rag/retrieve';
import { catalogModelContext } from '../rag/catalog-models';
import {
  chatCompletion,
  type ModelConfig,
  type ModelMessage,
} from './chat-model';
import { buildConversationPrompt } from './prompts';
import { evaluationPolicyPrompt } from './evaluation-policy';
import type { Draft } from './conversation-state';
import { toolProgress } from './progress';
import { renderSupportReply } from '../support/reply';
import {
  activeExecutionNode,
  advanceExecutionPlan,
  executionPlanPrompt,
  executionPlanReply,
  expectedResultPending,
} from './execution-plan';

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

export function availableTools(runtime: ToolRuntime, _taskCount?: number) {
  const tools = availableBusinessTools(runtime);
  if (
    canReplan(runtime) &&
    !tools.some((tool) => tool.function.name === 'revise_execution_plan')
  )
    tools.push(
      ...toolDefinitions.filter(
        (tool) => tool.function.name === 'revise_execution_plan',
      ),
    );
  return tools;
}

function availableBusinessTools(runtime: ToolRuntime) {
  if (runtime.requestAction === 'pending')
    return toolDefinitions.filter(
      (tool) => tool.function.name === 'set_request_action',
    );
  const restrictedNames = restrictedToolNames(runtime);
  if (
    restrictedNames !== undefined &&
    (!runtime.executionPlan ||
      [
        'search_catalog',
        'retrieve_knowledge',
        'explain_selection',
        'find_replacements',
        'evaluate_plan',
        'other',
      ].includes(runtime.requestAction ?? '') ||
      runtime.consultPrebuiltId ||
      runtime.readOnlyEvaluationTurn)
  )
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
  return toolDefinitions.filter(
    (tool) =>
      names.has(tool.function.name) &&
      (restrictedNames === undefined ||
        restrictedNames.includes(tool.function.name)),
  );
}

function requestedToolPending(runtime: ToolRuntime) {
  return (
    (runtime.consultPrebuiltId !== undefined &&
      !runtime.consultPrebuiltQueried) ||
    (requestToolActions.some((name) => name === runtime.requestAction) &&
      !runtime.facts
        .slice(runtime.executionPlan?.factStart ?? 0)
        .some(
          (fact) =>
            fact.tool === runtime.requestAction &&
            (!runtime.executionPlan || !fact.failed),
        ))
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
        executionPlanPrompt(runtime) +
        catalogPaginationHint(runtime) +
        (runtime.requestAction === 'pending'
          ? `\n入口规划可引用的主工具参数契约：${JSON.stringify(planningToolContracts())}。这不是额外权限，未知参数留给节点内工具循环；不得为节省调用猜测商品ID。\n`
          : '') +
        buildConversationPrompt({
          taskId: context.taskId,
          currentMessageId: context.currentMessageId,
          draft: runtime.draft,
          result: runtime.result,
          tasks: context.tasks,
          // 参数原文已在工具调用消息中，状态摘要不再重复嵌入整份入口计划。
          facts: runtime.facts.map(
            ({ arguments: _arguments, ...fact }) => fact,
          ),
          exploration: runtime.exploration,
        }) +
        `\n本轮结构化动作：${runtime.requestAction ?? '未记录'}。recommend 必须先保存用户当前及历史明确需求，齐全后同轮推荐；clarify 保存已有字段并追问缺失预算用途；save_requirements 必须记录需求，不生成；具体工具动作必须实际调用同名工具，失败时依据返回问题解释或修正，不可用口头答应代替执行；other 仅无需工具的回答或澄清。不得从已有预算或自己的回复推导生成授权。` +
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
          : '不可用。售前知识咨询只解释工具返回的数据库已有规格或追问需求，并说明知识检索不可用；不得补充未记录的性能或规格。售后仍须retrieve_knowledge，故障主题明确时提供topicId以读取同主题本地资料；无适用资料时只选questionId澄清。普通配机无需插入此提示。') +
        evaluationPolicyPrompt(),
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
  if (resumedEvaluation)
    messages.push({
      role: 'system',
      content: `本轮编号仅指定评估对象；程序已执行evaluate_plan，结果：${JSON.stringify(resumedEvaluation)}。本轮禁止选定、购买确认或修改配置。请按结果回答。`,
    });
  const replacementQueries: ModelMessage[] = [];
  let completionRepairs = 0;
  let requireAction = false;
  let modelCalls = 0;
  const toolSelections: { tool?: string; reason: string; elapsedMs: number }[] =
    [];
  const preparedReads = new Map<string, PreparedRead>();

  // 初次页面消息的窄范围只读入口；历史指代、售后及咨询附件保持原语义链。
  let jevEntry: ModelMessage | undefined;
  if (
    process.env.JEV_ROUTER_ENABLED === 'true' &&
    process.env.TYPESAFE_API_KEY &&
    !state.messages.length &&
    !consultPrebuiltId &&
    !runtime.draft.support &&
    runtime.requestAction === 'pending' &&
    message.length <= 1000
  ) {
    const decision = await tryJevRoute(message, {
      key: process.env.TYPESAFE_API_KEY,
      model: process.env.TYPESAFE_MODEL,
      signal,
    });
    if (decision.nodes)
      jevEntry = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: crypto.randomUUID(),
            type: 'function',
            function: {
              name: 'set_request_action',
              arguments: JSON.stringify({
                sourceMessageId: messageId,
                nodes: decision.nodes.map(
                  ({ status: _status, ...node }) => node,
                ),
              }),
            },
          },
        ],
      };
  }

  const lastAcceptanceFailure = () =>
    [...(runtime.failedAttempts?.values() ?? [])].reverse().find((failure) => {
      const observation = failure.observation;
      return (
        observation &&
        typeof observation === 'object' &&
        'stage' in observation &&
        ['requirements', 'compatibility'].includes(String(observation.stage))
      );
    });
  // 用户约定的主循环步数上限；验收修复也消耗同一预算。
  const maxRounds = 8;
  for (let round = 0; round < maxRounds; round++) {
    signal?.throwIfAborted();
    await prepareParallelReads(runtime, context, availableTools, preparedReads);
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
        expectedResultPending(runtime) ||
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
      (!runtime.executionPlan || runtime.executionPlan.nodes.length === 1) &&
      !hasUnfinishedWork() &&
      !(
        runtime.requestAction === 'recommend' &&
        (!runtime.draft.budget || !runtime.draft.purpose)
      ) &&
      !runtime.knowledgeUnavailable &&
      !renderSupportReply(runtime, context);
    const tools = availableTools(runtime, context.tasks.length);
    const noSuitableTool =
      requestToolActions.some((action) => action === runtime.requestAction) &&
      requestedToolPending(runtime) &&
      !tools.some((tool) => tool.function.name === runtime.requestAction);
    let response: ModelMessage;
    let selectedToolName: string | undefined;
    const prepared = preparedReads.get(runtime.executionPlan?.activeId ?? '');
    const direct = prepared?.invocation ?? directTaskInvocation(runtime, tools);
    try {
      if (direct) {
        activeExecutionNode(runtime)!.directAttempted = true;
        response = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: crypto.randomUUID(),
              type: 'function',
              function: {
                name: direct.tool,
                arguments: JSON.stringify(direct.arguments),
              },
            },
          ],
        };
        // 直执行不占模型调用额度；每个节点最多尝试一次，失败仍进入原有受限循环。
        round--;
      } else if (jevEntry) {
        response = jevEntry;
        jevEntry = undefined;
        round--;
      } else {
        if (
          process.env.JEV_TOOL_SELECTOR_ENABLED === 'true' &&
          process.env.TYPESAFE_API_KEY &&
          runtime.requestAction !== 'pending' &&
          hasUnfinishedWork() &&
          tools.length > 1 &&
          round < maxRounds - 1
        ) {
          const decision = await selectToolWithJev(
            tools,
            {
              task: activeExecutionNode(runtime),
              draft: runtime.draft,
              exploration: runtime.exploration,
              facts: runtime.facts,
              messages: messages.filter((entry) => entry.role !== 'system'),
            },
            {
              key: process.env.TYPESAFE_API_KEY,
              model: process.env.TYPESAFE_MODEL,
              signal,
            },
          );
          toolSelections.push(decision);
          selectedToolName = decision.tool;
        }
        modelCalls++;
        response = await chatCompletion(
          config,
          messages,
          selectedToolName
            ? tools.filter((tool) => tool.function.name === selectedToolName)
            : tools,
          selectedToolName
            ? 'required'
            : (requireAction ||
                  runtime.requestAction === 'pending' ||
                  (requestedToolPending(runtime) &&
                    !noSuitableTool &&
                    ((runtime.consultPrebuiltId &&
                      !runtime.consultPrebuiltQueried) ||
                      !runtime.facts
                        .slice(runtime.executionPlan?.factStart ?? 0)
                        .some(
                          (fact) => fact.tool === runtime.requestAction,
                        )))) &&
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
      }
    } catch (cause) {
      signal?.throwIfAborted();
      throw cause;
    }
    requireAction = false;
    messages.push(response);
    if (!response.tool_calls?.length) {
      const content = response.content?.trim() ?? '';
      const node = activeExecutionNode(runtime);
      const nodeFacts = runtime.facts.slice(
        runtime.executionPlan?.factStart ?? 0,
      );
      // 只按工具事实判定，模型声称成功不构成完成依据。
      const nodeFailed =
        !!node &&
        hasUnfinishedWork() &&
        (noSuitableTool ||
          (expectedResultPending(runtime) && completionRepairs >= 2) ||
          nodeFacts.some(
            (fact) =>
              fact.failed &&
              !fact.rejected &&
              toolMetadata[fact.tool]?.taskTypes.includes(node.action),
          )) &&
        (!(runtime.consultPrebuiltId && !runtime.consultPrebuiltQueried) ||
          completionRepairs >= 2);
      if (node && (!hasUnfinishedWork() || nodeFailed)) {
        node.status =
          nodeFailed ||
          runtime.exploration?.status === 'blocked' ||
          node.action === 'clarify' ||
          (node.action === 'evaluate_plan' && !!runtime.pendingEvaluation) ||
          (node.action === 'recommend' &&
            runtime.requestAction === 'save_requirements') ||
          (node.action === 'recommend' &&
            (!runtime.draft.budget || !runtime.draft.purpose))
            ? 'blocked'
            : 'completed';
        node.outcome =
          node.status === 'completed'
            ? 'succeeded'
            : node.action === 'clarify' ||
                !!runtime.pendingEvaluation ||
                (node.action === 'recommend' &&
                  (!runtime.draft.budget ||
                    !runtime.draft.purpose ||
                    runtime.requestAction === 'save_requirements'))
              ? 'waiting_user'
              : 'failed';
        if (node.outcome === 'failed')
          node.errorCode = noSuitableTool
            ? 'NO_SUITABLE_TOOL'
            : expectedResultPending(runtime)
              ? 'RESULT_MISMATCH'
              : 'TOOL_FAILED';
        const missing = [
          !runtime.draft.budget ? '主机预算' : '',
          !runtime.draft.purpose ? '主要用途' : '',
        ]
          .filter(Boolean)
          .join('和');
        node.reply =
          renderSupportReply(runtime, context) ??
          (node.action === 'recommend' && missing
            ? `还需要确认${missing}，才能生成并在右侧展示完整配置。请告诉我${missing}。`
            : nodeFailed
              ? noSuitableTool
                ? '当前状态没有可执行该任务的工具；未修改配置，请补充所需前置条件。'
                : expectedResultPending(runtime)
                  ? '工具结果尚未达到本项预期目标，本项未完成。'
                  : nodeFacts
                      .filter((fact) => fact.failed)
                      .map((fact) => fact.error ?? '工具执行失败')
                      .join('；')
              : node.action === 'save_requirements' &&
                  runtime.executionPlan!.nodes.length > 1
                ? `需求已在本次对话记录，当前预算${runtime.draft.budget ?? '未提供'}元，本项未生成配置。`
                : content);
        if (!node.reply) throw Error('模型没有返回最终回复');
        if (
          advanceExecutionPlan(
            runtime,
            context.currentMessageId,
            context.taskId,
          )
        ) {
          messages[0] = modelContext(runtime, context, currentUser, [])[0];
          continue;
        }
        answer = executionPlanReply(runtime.executionPlan!);
        break;
      }
      if (hasUnfinishedWork()) {
        if (completionRepairs >= 2 || round >= maxRounds - 1) {
          const rejection = lastAcceptanceFailure();
          if (rejection)
            throw new ToolExecutionError(
              `修复预算已耗尽；${rejection.error}`,
              rejection.observation,
            );
          throw Error(
            '模型尚未执行完配置操作，请重试；本次对话已记录的需求仍保留',
          );
        }
        completionRepairs++;
        requireAction = true;
        messages.push({
          role: 'system',
          content: `本轮结构化动作或必要操作尚未完成，纯文本回复未交付。当前动作=${runtime.requestAction}。动作未记录时先调用set_request_action。clarify也必须先调用update_requirements保存全部已知无冲突需求，没有已知需求时传空对象；局部冲突不能丢弃其他已知信息。具体工具动作必须执行对应工具；只根据执行结果说明成功或具体阻碍。recommend先保存需求，预算用途齐全后同轮调用recommend_pc；工具报告本轮无法继续时用finish_exploration记录具体阻碍。咨询、售后、局部修改、暂不生成不得强制配机。不从助手措辞推导用户意图。`,
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
      answer = supportAnswer ?? content;
      if (!answer) throw Error('模型没有返回最终回复');
      break;
    }
    if (streamedText) onText?.('');
    const toolMessages: ModelMessage[] = [];
    let directOutput: unknown;
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
        if (selectedToolName && call.function.name !== selectedToolName)
          throw Error('本轮工具已由Jev选择，参数生成不得改选工具');
        if (
          !availableTools(runtime, context.tasks.length).some(
            (tool) => tool.function.name === call.function.name,
          )
        )
          throw Error(`当前状态不可调用工具：${call.function.name}`);
        const toolOutput =
          prepared && direct && call.function.name === prepared.invocation.tool
            ? consumePreparedRead(prepared, runtime, context)
            : await executeRegisteredTool(
                call.function.name,
                JSON.parse(call.function.arguments || '{}'),
                context,
                runtime,
              );
        if (prepared) preparedReads.delete(runtime.executionPlan!.activeId!);
        output = toolOutput;
        if (call.function.name === 'search_catalog')
          recordCatalogPage(
            runtime,
            JSON.parse(call.function.arguments || '{}'),
            toolOutput,
          );
        if (direct) directOutput = toolOutput;
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
            error,
          },
        };
        runtime.facts.push({
          rejected: true,
          tool: call.function.name,
          nodeId: runtime.executionPlan?.activeId,
          requirementsChanged: false,
          partsChanged: false,
          quoteChanged: false,
          hasPendingItems:
            runtime.result?.plans.some(
              (plan) => plan.validation.status === 'unknown',
            ) ?? false,
          failed: true,
          error,
        });
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
    if (direct && canCompleteDirectQuery(runtime, directOutput)) {
      const node = activeExecutionNode(runtime)!;
      node.status = 'completed';
      node.outcome = 'succeeded';
      node.reply = '本项目录查询已完成。';
      if (
        advanceExecutionPlan(runtime, context.currentMessageId, context.taskId)
      ) {
        messages[0] = modelContext(runtime, context, currentUser, [])[0];
      } else {
        answer = executionPlanReply(runtime.executionPlan!);
        break;
      }
    }
  }

  if (!answer) {
    const rejection = lastAcceptanceFailure();
    if (rejection)
      throw new ToolExecutionError(
        `修复预算已耗尽；${rejection.error}`,
        rejection.observation,
      );
    throw Error('模型在最大轮数内没有返回最终回复');
  }
  const plan = runtime.executionPlan;
  if (plan && plan.nodes.length > 1) {
    if (plan.nodes.some((node) => node.status !== 'completed')) {
      // 未完成时不拼入模型早先可能跨节点承诺的正文，逐项交付程序核验状态。
      answer = plan.nodes
        .map((node) =>
          node.status === 'completed'
            ? `已处理：${node.goal}\n${node.action === 'save_requirements' ? `需求已在本次对话记录，当前预算${runtime.draft.budget ?? '未提供'}元，本项未生成配置。` : '本项操作已执行完成。'}`
            : `未完成：${node.goal}\n${node.reply ?? '本项尚未执行。'}`,
        )
        .join('\n\n');
    } else if (
      modelCalls < maxRounds &&
      !plan.nodes.some(
        (node) =>
          node.action === 'update_support' || node.otherTopic === 'support',
      )
    ) {
      // 售后仍使用受控交付；其他复合请求只在剩余模型额度内作一次统一收尾。
      const synthesis = await chatCompletion(
        config,
        [
          modelContext(runtime, context, currentUser, [])[0],
          {
            role: 'system',
            content: `所有任务已由程序核验完成。仅依据下列工具结果和当前状态统一回答用户全部需求；忽略规划时的预期作为事实来源，不重复逐节点收尾，不发起任何新操作。任务状态：${JSON.stringify(plan.nodes.map(({ id, goal, status, outcome }) => ({ id, goal, status, outcome })))}`,
          },
          { role: 'user', content: userMessageContent(currentUser) },
          ...messages
            .slice(1)
            .filter(
              (entry) =>
                entry.role === 'tool' ||
                (entry.role === 'assistant' && entry.tool_calls?.length),
            ),
        ],
        [],
        'none',
        signal,
      );
      modelCalls++;
      if (synthesis.tool_calls?.length || !synthesis.content?.trim())
        throw Error('最终汇总未返回有效文本');
      answer = synthesis.content.trim();
    }
  }
  // 显示工具已确认的降级状态；这里不判断意图或生成知识性结论。
  if (
    !supportAnswer &&
    runtime.knowledgeUnavailable &&
    !answer.includes('知识检索不可用')
  )
    answer =
      '知识检索不可用，以下仅依据数据库已有规格与程序审核结果。\n\n' + answer;
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
    executionPlan: runtime.executionPlan,
    modelCalls,
    toolSelections,
  };
}
