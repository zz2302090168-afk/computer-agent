import type { ToolDefinition } from '../agent/chat-model';
import {
  applySuggestionTool,
  assembleBuildTool,
  recommendPcTool,
  selectPrebuiltTool,
  finishExplorationTool,
  replacePartsTool,
  evaluatePlanTool,
  explainSelectionTool,
  selectPlanTool,
  findReplacementsTool,
} from './build';
import { searchCatalogTool } from './catalog';
import { retrieveKnowledgeTool } from './knowledge';
import { updateSupportTool } from './support';
import {
  authorizeSelectionTool,
  confirmSelectionsTool,
  updateRequirementsTool,
} from './requirements';
import {
  createTaskTool,
  resetCurrentTaskTool,
  switchTaskTool,
  undoLastChangeTool,
} from './tasks';
import type { RegisteredTool, ToolContext, ToolRuntime } from './types';
import { MAX_CANDIDATE_ATTEMPTS, ToolExecutionError } from './types';

export const registeredTools = [
  updateSupportTool,
  selectPlanTool,
  findReplacementsTool,
  explainSelectionTool,
  replacePartsTool,
  undoLastChangeTool,
  updateRequirementsTool,
  authorizeSelectionTool,
  confirmSelectionsTool,
  recommendPcTool,
  searchCatalogTool,
  assembleBuildTool,
  selectPrebuiltTool,
  finishExplorationTool,
  retrieveKnowledgeTool,
  evaluatePlanTool,
  applySuggestionTool,
  createTaskTool,
  switchTaskTool,
  resetCurrentTaskTool,
] as const;

// 注册表是工具名称到执行入口的唯一映射，启动和测试时都能发现重名。
export function createToolRegistry(tools: readonly RegisteredTool[]) {
  const entries = tools.map(
    (tool) => [tool.definition.function.name, tool] as const,
  );
  if (new Set(entries.map(([name]) => name)).size !== entries.length)
    throw Error('Function Calling 工具名称重复');
  return new Map(entries);
}

const registry = createToolRegistry(registeredTools);
const stateChangingTools = new Set([
  'apply_suggestion',
  'assemble_build',
  'authorize_selection',
  'confirm_selections',
  'create_task',
  'recommend_pc',
  'replace_parts',
  'reset_current_task',
  'select_plan',
  'select_prebuilt',
  'switch_task',
  'undo_last_change',
  'update_requirements',
  'update_support',
]);
const preservesConfigurationOnFailure = new Set([
  'replace_parts',
  'undo_last_change',
  'explain_selection',
  'select_plan',
  'find_replacements',
]);
export const toolDefinitions: ToolDefinition[] = registeredTools.map(
  (tool) => tool.definition,
);

function snapshot(runtime: ToolRuntime) {
  const requirementState = {
    ...runtime.draft,
    support: undefined,
    partSelections: undefined,
    selectionSources: undefined,
    selectionConfirmationMessageIds: undefined,
  };
  return {
    requirements: JSON.stringify(requirementState),
    // “选了什么”和“由谁选择/是否确认”都属于右侧配件状态，不能只比较商品 ID。
    parts: JSON.stringify({
      selections: runtime.draft.partSelections ?? {},
      sources: runtime.draft.selectionSources ?? {},
      confirmations: runtime.draft.selectionConfirmationMessageIds ?? {},
    }),
    quote: JSON.stringify(
      runtime.result?.plans.map((plan) => [plan.id, plan.total]) ?? [],
    ),
  };
}

function facts(
  name: string,
  before: ReturnType<typeof snapshot>,
  runtime: ToolRuntime,
  failed: boolean,
  error?: string,
) {
  const after = snapshot(runtime),
    operation = {
      tool: name,
      requirementsChanged: before.requirements !== after.requirements,
      partsChanged: before.parts !== after.parts,
      quoteChanged: before.quote !== after.quote,
      hasPendingItems:
        runtime.result?.plans.some(
          (plan) => plan.validation.status === 'unknown',
        ) ?? false,
      failed,
      ...(error ? { error } : {}),
    };
  runtime.facts.push(operation);
  return operation;
}

export async function executeRegisteredTool(
  name: string,
  argumentsValue: unknown,
  context: ToolContext,
  runtime: ToolRuntime,
) {
  const before = snapshot(runtime);
  const tool = registry.get(name);
  if (!tool) {
    const error = `不支持的工具：${name}`;
    runtime.toolErrors.push(error);
    return { error, operation: facts(name, before, runtime, true, error) };
  }
  if (runtime.readOnlyEvaluationTurn && stateChangingTools.has(name)) {
    const error = '本轮只读评估已经完成；如要修改，请在下一条消息明确接受具体建议或提出新需求';
    return { error, operation: facts(name, before, runtime, true, error) };
  }
  if (name === 'recommend_pc') {
    const key = before.requirements;
    runtime.recommendationAttemptKeys ??= new Set();
    if (runtime.recommendationAttemptKeys.size) {
      const error = '本轮已经启动过候选探索，不能重新开始以重置修正额度';
      return { error, operation: facts(name, before, runtime, true, error) };
    }
    runtime.recommendationAttemptKeys.add(key);
  }
  if (name === 'assemble_build' || name === 'select_prebuilt') {
    if (runtime.recommendationAttemptKeys?.size) {
      const error = '本轮推荐已在受限分支内完成候选修正，不能在外层追加组合审核次数';
      return { error, operation: facts(name, before, runtime, true, error) };
    }
    const input =
      argumentsValue && typeof argumentsValue === 'object'
        ? (argumentsValue as Record<string, unknown>)
        : {};
    const key =
      name === 'assemble_build' && Array.isArray(input.productIds)
        ? `diy:${input.productIds.map(String).sort().join('|')}`
        : name === 'select_prebuilt' && typeof input.prebuiltId === 'string'
          ? `prebuilt:${input.prebuiltId}`
          : null;
    if (key) {
      runtime.candidateSubmissionKeys ??= new Set();
      if (runtime.candidateSubmissionKeys.has(key)) {
        const error = '该候选组合本轮已经提交过，不能重复审核';
        return { error, operation: facts(name, before, runtime, true, error) };
      }
      if (runtime.candidateSubmissionKeys.size >= MAX_CANDIDATE_ATTEMPTS) {
        const error = `本轮已达到 ${MAX_CANDIDATE_ATTEMPTS} 个不重复候选组合的修正上限`;
        return { error, operation: facts(name, before, runtime, true, error) };
      }
      runtime.candidateSubmissionKeys.add(key);
    }
  }
  if (name === 'replace_parts') runtime.localEdit = true;
  const normalized =
    argumentsValue && typeof argumentsValue === 'object'
      ? Object.fromEntries(
          Object.entries(argumentsValue)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [
              key,
              key === 'productIds' && Array.isArray(value)
                ? [...value].sort((a, b) => String(a).localeCompare(String(b)))
                : value,
            ]),
        )
      : argumentsValue;
  const attemptKey = JSON.stringify([
    context.taskId,
    before.requirements,
    name,
    normalized,
    runtime.result?.selection?.planId,
    runtime.result?.plans.map((plan) => [
      plan.id,
      plan.total,
      plan.parts.map((part) => part.id),
    ]),
    context.catalog,
  ]);
  // 售后调用的可用知识会随检索改变，失败不参与配机候选去重或自动探索。
  const previous =
    name === 'update_support'
      ? undefined
      : runtime.failedAttempts?.get(attemptKey);
  if (previous) {
    runtime.exploration = {
      status: preservesConfigurationOnFailure.has(name)
        ? 'blocked'
        : 'continue',
      reason: previous.error,
    };
    return {
      error:
        '相同条件下已尝试失败，请依据上次反馈更换候选或查询条件，不要重复提交',
      observation: { previous, repeated: true },
      task: runtime.exploration,
      operation: facts(name, before, runtime, true, previous.error),
    };
  }
  try {
    if (
      runtime.localEdit &&
      [
        'recommend_pc',
        'assemble_build',
        'select_prebuilt',
        'update_requirements',
      ].includes(name)
    )
      throw Error(
        '本轮为局部替换，只能继续replace_parts调整指定配件；不能清空原方案或重新生成整套',
      );
    const data = await tool.execute(argumentsValue, context, runtime);
    if (name === 'evaluate_plan') runtime.readOnlyEvaluationTurn = true;
    if (
      preservesConfigurationOnFailure.has(name) &&
      runtime.exploration?.status === 'blocked' &&
      runtime.facts.at(-1)?.tool === name &&
      runtime.facts.at(-1)?.failed
    )
      runtime.exploration = undefined;
    if (
      [
        'update_requirements',
        'authorize_selection',
        'create_task',
        'reset_current_task',
      ].includes(name)
    )
      runtime.exploration =
        runtime.draft.budget && runtime.draft.purpose
          ? {
              status: 'continue',
              reason: '需求已保存，尚需根据数据库候选生成并校验配置',
            }
          : undefined;
    if (name === 'switch_task') runtime.exploration = undefined;
    if (
      [
        'recommend_pc',
        'assemble_build',
        'select_prebuilt',
        'replace_parts',
        'select_plan',
      ].includes(name)
    ) {
      const plan =
        runtime.result?.plans.find(
          (item) => item.id === runtime.result?.selection?.planId,
        ) ?? runtime.result?.plans[0];
      const diagnostic = runtime.result?.budgetDiagnostic;
      runtime.exploration = plan
        ? {
            status: plan.budget.confirmable ? 'ready' : 'reference',
            reason: plan.budget.reason,
          }
        : {
            status: diagnostic?.searchComplete ? 'blocked' : 'continue',
            reason: diagnostic?.reason ?? '没有生成有效配置，需要继续查询候选',
          };
    }
    return {
      data,
      task: runtime.exploration,
      operation: facts(name, before, runtime, false),
    };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : '工具执行失败';
    if (name === 'recommend_pc')
      context.onProgress?.({
        scope: 'main',
        label: '本轮候选未通过最终审核，继续处理',
        status: 'error',
        invalidatePlans: true,
      });
    const observation =
      cause instanceof ToolExecutionError ? cause.observation : undefined;
    runtime.failedAttempts ??= new Map();
    runtime.failedAttempts.set(attemptKey, { error, observation });
    const auditFailed =
      observation &&
      typeof observation === 'object' &&
      'code' in observation &&
      observation.code === 'delivery_audit_failed';
    if (auditFailed && !preservesConfigurationOnFailure.has(name)) {
      runtime.result = null;
      runtime.draft = {
        ...runtime.draft,
        partSelections: {},
        selectionSources: {},
        selectionConfirmationMessageIds: {},
      };
      await context.onUpdate?.('plan', runtime.draft, null);
    }
    if (
      auditFailed ||
      ['assemble_build', 'select_prebuilt', 'recommend_pc'].includes(name)
    )
      runtime.exploration = { status: 'continue', reason: error };
    if (preservesConfigurationOnFailure.has(name))
      runtime.exploration = {
        status: 'blocked',
        reason: error + '；当前需求与配置未修改。',
      };
    runtime.toolErrors.push(error);
    return {
      error,
      observation,
      task: runtime.exploration,
      operation: facts(name, before, runtime, true, error),
    };
  }
}
