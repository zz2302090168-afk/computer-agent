import type {
  Catalog,
  PcTask,
  RecommendationResult,
  TaskSummary,
} from '../domain/types';
import { budgetRange } from '../rules/budget';
import { recommend } from '../services/recommend';
import { retrieveKnowledge } from '../rag/retrieve';
import { executeRegisteredTool, toolDefinitions } from '../tools/registry';
import type { ToolRuntime } from '../tools/types';
import {
  chatCompletion,
  type ModelConfig,
  type ModelMessage,
} from './chat-model';
import diySkill from '../../skills/diy-recommendation/SKILL.md?raw';
import prebuiltSkill from '../../skills/prebuilt-recommendation/SKILL.md?raw';
import {
  applyDraft,
  changesRecommendation,
  completeRequirements,
  inferExplicitPatch,
  type Draft,
} from './conversation-state';

export type { Draft } from './conversation-state';
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: string[];
  taskId?: string;
};
export type StateEvent = {
  type: 'requirements' | 'parts' | 'plan';
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

function plainReply(value: string) {
  return value
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .trim()
    .slice(0, 500);
}

/**
 * 只协调模型循环、工具调度和最终话术。具体参数校验与业务执行都由注册工具负责。
 * 每轮最多处理十次调用，总轮数最多六轮；最后一轮关闭工具，防止模型无限递归调用。
 */
export async function runConversation(
  config: ModelConfig,
  state: ChatState,
  message: string,
  catalog: Catalog,
  reloadCatalog: () => Promise<Catalog> = async () => catalog,
  onUpdate?: (
    type: StateEvent['type'],
    draft: Draft,
    result: RecommendationResult | null,
  ) => Promise<number>,
  sessionId?: string,
) {
  // 询问改进空间属于评估，不等于授权修改；本轮只开放读取工具。
  const adviceOnly =
    !!state.result?.plans.length &&
    /(?:还能|可以|能否|是否|有没有|怎么|如何).*(?:改进|优化|提升)|(?:优缺点|有什么不足|为什么)/.test(
      message,
    ) &&
    !/(?:直接|帮我|替我|现在就).*(?:改|优化|换)/.test(message);
  const availableTools = adviceOnly
    ? toolDefinitions.filter((tool) =>
        ['search_catalog', 'retrieve_knowledge'].includes(tool.function.name),
      )
    : toolDefinitions;
  const explicitPatch = adviceOnly ? {} : inferExplicitPatch(message);
  if (
    /(?:这张|这个|该)(?:显卡|GPU).*你选/i.test(message) &&
    state.draft.seriesPreferences?.gpu
  )
    explicitPatch.selectionAuthorizations = {
      gpu: state.draft.seriesPreferences.gpu,
    };
  if (
    /^(?:可以|确认|接受|就这(?:套|个)?|按这个)(?:了|吧)?[。！!]?$/i.test(
      message,
    ) &&
    state.draft.partSelections
  )
    explicitPatch.selectionSources = Object.fromEntries(
      Object.keys(state.draft.partSelections).map((category) => [
        category,
        'confirmed',
      ]),
    );
  const initial = applyDraft(state.draft, explicitPatch),
    recommendationChanged = changesRecommendation(state.draft, initial);
  const runtime: ToolRuntime = {
    draft: initial,
    result: recommendationChanged ? null : state.result,
    explicitPatch,
    approvedPartIds: new Set(),
    attemptedPlanTool: false,
    successfulPlanTool: '',
    ambiguousSearch: false,
    emptySearch: false,
    specifiedUpdated: false,
    toolsUsed: [],
    toolErrors: [],
  };
  const context = {
    sessionId,
    taskId: state.currentTaskId,
    catalog,
    reloadCatalog,
    onUpdate,
  };
  if (JSON.stringify(state.draft) !== JSON.stringify(initial) && onUpdate)
    await onUpdate('requirements', runtime.draft, runtime.result);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: `你是专业的中文电脑装机顾问，通过工具完成推荐。先配主机，不提前讨论显示器。预算和用途齐全就主动使用工具。只记录用户明确表达的信息。用户说便宜一点时保留预算。需求变化后重新推荐。
用户指定具体型号时，先调用 search_catalog。唯一匹配后用 update_requirements 将真实商品 ID 保存到 partPreferences，再调用 recommend_pc 或 assemble_build；同一句指定 CPU 和 GPU 时必须分开按类别查询，逐项保存唯一匹配，不能因另一项不确定而丢弃已明确型号。多个品牌或版本时列出真实匹配版本作简短澄清，并允许用户说“你选”；不要反复要求用户重复已经给出的芯片型号。已有明确选择授权时直接在授权范围内选型。不得静默替换指定型号。整机模式只能选数据库整机；修改整机配件前切换为 DIY。如果用户明确要求你自主选择具体型号或调用 assemble_build，你必须最终调用 assemble_build；可以先用 recommend_pc 取得八类基础 ID，再自主替换其中型号并提交，不得停在查询步骤。
只有服务端工具结果能决定商品、价格、总价和兼容性。资料不足显示待确认，已知冲突不得推荐。解释方案时逐项遵守 validation.issues：待确认项不能说“稳妥兼容”“足够压制”。TDP 不等于实际功耗，不能据此保证散热能力。具体升级差价必须查询目录并计算，未查询就只说明调整方向，不报估计价格。不把建议包装成已验证的性能提升。当前版本不提供帧率预测；用户主动询问时只需简短说明。
左侧只输出简短自然中文纯文本，用于追问、回应修改、解释无解或提示查看右侧。禁止 Markdown、列表、表格、配置清单、型号组合、逐项价格、总价对比和长报告。成功与否由工具决定；工具失败时不得声称已更新。
本轮交互：${adviceOnly ? '用户在询问改进意见。结合当前实际配件给出一到两个具体取舍，不修改配置，不声称已更新。没有证据不保证性能提升。左侧可以解释建议，完整配置仍只在右侧显示。' : '按用户需求执行；已有方案且需求未改变时，不要无故重新推荐。'}
当前需求：${JSON.stringify(runtime.draft)}
当前方案：${JSON.stringify(runtime.result?.plans.map((plan) => ({ id: plan.id, total: plan.total, name: plan.name, parts: plan.parts.map((p) => ({ category: p.category, name: p.name, price: p.price, specs: p.specs })), validation: plan.validation })) ?? [])}
${diySkill}
${prebuiltSkill}`,
    },
    ...state.messages
      .slice(-16)
      .map((item) => ({ role: item.role, content: item.content })),
    { role: 'user', content: message },
  ];

  for (let round = 0; round < 6; round++) {
    const response = await chatCompletion(
      config,
      messages,
      availableTools,
      round < 5,
    );
    messages.push(response);
    if (!response.tool_calls?.length) break;
    for (const call of response.tool_calls.slice(0, 10)) {
      let output: unknown;
      try {
        if (
          !availableTools.some(
            (tool) => tool.function.name === call.function.name,
          )
        )
          throw Error('本轮仅允许查询');
        const parsed: unknown = JSON.parse(call.function.arguments || '{}');
        output = await executeRegisteredTool(
          call.function.name,
          parsed,
          context,
          runtime,
        );
      } catch {
        const error = '工具参数不是有效 JSON';
        runtime.toolErrors.push(error);
        output = { error };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output),
      });
    }
  }

  // 局部授权已经足够确定选择空间时提供确定性兜底，避免模型因多条目录结果再次追问。
  if (
    !adviceOnly &&
    !runtime.attemptedPlanTool &&
    Object.keys(runtime.draft.selectionAuthorizations ?? {}).length &&
    runtime.draft.budget &&
    runtime.draft.purpose
  ) {
    let requirements = completeRequirements(runtime.draft);
    context.catalog = await reloadCatalog();
    const plans = recommend(
      requirements,
      context.catalog.parts,
      context.catalog.prebuilts,
    );
    if (plans[0]) {
      const partSelections = Object.fromEntries(
          plans[0].parts.map((part) => [part.category, part.id]),
        ),
        selectionSources = Object.fromEntries(
          plans[0].parts.map((part) => [
            part.category,
            runtime.draft.partPreferences?.[part.category] &&
            runtime.draft.selectionSources?.[part.category] !== 'assistant'
              ? 'user'
              : 'assistant',
          ]),
        );
      runtime.draft = applyDraft(runtime.draft, {
        partSelections,
        selectionSources,
      });
      requirements = completeRequirements(runtime.draft);
      await onUpdate?.('parts', runtime.draft, null);
    }
    const range = budgetRange(requirements.budget, requirements.hardCap),
      evidence = retrieveKnowledge(
        `${requirements.purpose} ${requirements.game} 预算 兼容`,
        5,
      );
    runtime.result = {
      requirements,
      plans,
      evidence,
      summary: plans.length
        ? `匹配 ${plans.length} 套候选 · 允许总价 ¥${range.min}～¥${range.max}`
        : '当前授权范围与预算下无匹配方案。',
      modelStatus: '模型对话与工具调用',
    };
    await onUpdate?.('plan', runtime.draft, runtime.result);
    runtime.attemptedPlanTool = true;
    if (plans.length) runtime.successfulPlanTool = 'recommend';
    runtime.toolsUsed.push('授权范围选型', '检查兼容性', '校验预算');
  }

  let answer = '';
  if (adviceOnly)
    answer =
      plainReply(
        messages.at(-1)?.role === 'assistant'
          ? (messages.at(-1)?.content ?? '')
          : '',
      ) ||
      '当前方案尚有兼容性待核对项，建议先确认这些资料，再决定是否调整配件。';
  else if (runtime.successfulPlanTool === 'assemble')
    answer =
      runtime.specifiedUpdated ||
      Object.keys(runtime.draft.partPreferences ?? {}).length
        ? '已按你指定的型号重新搭配，更新后的方案显示在右侧。'
        : '已完成自主选型，服务端校验后的方案显示在右侧。';
  else if (
    runtime.successfulPlanTool === 'recommend' &&
    runtime.specifiedUpdated
  )
    answer = '已按你指定的型号重新搭配，更新后的方案显示在右侧。';
  else if (runtime.successfulPlanTool === 'recommend')
    answer =
      '已按你的预算和用途完成选配，方案显示在右侧。你可以继续告诉我想调整的配件。';
  else if (
    runtime.ambiguousSearch &&
    !runtime.attemptedPlanTool &&
    !Object.keys(runtime.draft.selectionAuthorizations ?? {}).length
  )
    answer =
      plainReply(
        messages.at(-1)?.role === 'assistant'
          ? (messages.at(-1)?.content ?? '')
          : '',
      ) ||
      '该型号有多个品牌版本。你可以指定品牌，或说“你选”，让我按现有预算和偏好选择。';
  else if (runtime.emptySearch && !runtime.attemptedPlanTool)
    answer = '目录中未找到这个指定型号，请核对完整型号、品牌或颜色后重试。';
  else if (
    runtime.attemptedPlanTool &&
    runtime.result &&
    !runtime.result.plans.length
  )
    answer =
      '当前条件下无匹配方案，右侧已清除旧方案。请调整预算或指定型号后重试。';
  else if (runtime.toolErrors.length)
    answer = `当前未能更新方案：${runtime.toolErrors.at(-1)}`;
  else
    answer =
      plainReply(messages.at(-1)?.content ?? '') ||
      '需求已记录，请继续告诉我你想调整的地方。';
  return {
    draft: runtime.draft,
    result: runtime.result,
    messages: [
      ...state.messages,
      { role: 'user' as const, content: message, taskId: state.currentTaskId },
      {
        role: 'assistant' as const,
        content: answer,
        toolsUsed: [...new Set(runtime.toolsUsed)],
        taskId: state.currentTaskId,
      },
    ].slice(-40),
  };
}
