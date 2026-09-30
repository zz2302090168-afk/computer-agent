import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  requestToolActions,
  supportActions,
  type ToolRuntime,
} from '../tools/types';
import { toolMetadata } from '../tools/metadata';
import { applyDraft } from './conversation-state';

export const requestActions = [
  'recommend',
  'clarify',
  'save_requirements',
  'other',
  ...requestToolActions,
] as const;
export type RequestAction = (typeof requestActions)[number];
export type ExecutionNode = {
  id: string;
  action: RequestAction;
  goal: string;
  sourceQuote: string;
  dependsOn: string[];
  catalogScope?: 'page' | 'all';
  catalogPageSize?: number;
  catalogProgress?: {
    key: string;
    nextOffset: number | null;
    total: number;
    ids: string[];
    complete: boolean;
  };
  otherTopic?: 'support' | 'general';
  supportAction?: (typeof supportActions)[number];
  status: 'pending' | 'running' | 'completed' | 'blocked';
  reply?: string;
  invocation?: { tool: string; arguments: Record<string, unknown> };
  expected?: { tool: string; arguments: Record<string, unknown> };
  directAttempted?: boolean;
  outcome?: 'succeeded' | 'failed' | 'waiting_user' | 'dependency_blocked';
  errorCode?:
    | 'TOOL_FAILED'
    | 'RESULT_MISMATCH'
    | 'NO_SUITABLE_TOOL'
    | 'DEPENDENCY_BLOCKED';
};
export type ExecutionPlan = {
  nodes: ExecutionNode[];
  activeId?: string;
  factStart: number;
  shape?: 'single' | 'sequential' | 'parallel' | 'dag';
  replans?: number;
  parallelDecision?: {
    mode: 'parallel' | 'serial';
    nodeIds: string[];
    reason: string;
  };
  parallelBatches?: string[][];
};

export const invocationSchema = objectSchema(
  {
    tool: { type: 'string' },
    arguments: { type: 'object', additionalProperties: true },
  },
  ['tool', 'arguments'],
);

export const executionNodesSchema = {
  type: 'array',
  description:
    '复合请求必须逐项列出所有独立意图。每项仅处理goal，sourceQuote引用当前消息原文。dependsOn表达先后依赖；没有依赖填[]。不要把同一配机流程的内部工具拆成意图。先保存新预算再按新预算查询时，查询依赖保存。明确暂不生成时不可安排recommend。',
  items: objectSchema(
    {
      id: {
        type: 'string',
        description: '按task1、task2、task3命名；dependsOn使用这些ID。',
      },
      action: { type: 'string', enum: requestActions },
      goal: { type: 'string' },
      catalogPageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description:
          '用户明确指定每页最多N条时填写N，程序强制执行；未指定时省略。',
      },
      sourceQuote: { type: 'string' },
      dependsOn: { type: 'array', items: { type: 'string' } },
      catalogScope: {
        type: 'string',
        enum: ['page', 'all'],
        description:
          'search_catalog查询范围：用户明确要求全部、查完、遍历所有页时必须填写all；普通查询、指定某页或只看前几条填page，不扩大用户范围。all从offset=0开始，按nextOffset连续翻页，筛选条件和每页limit保持不变。',
      },
      otherTopic: {
        type: 'string',
        enum: ['support', 'general'],
        description:
          '仅other必填：售后咨询用support，商品目录入口及普通交谈用general。不从已有售后状态推断。',
      },
      supportAction: {
        type: 'string',
        enum: supportActions,
        description:
          '仅update_support必填。continue记录进展；new_issue另一故障；stop停止排查；resolved明确已恢复；handoff明确现在请求人工。否定、条件假设、入口咨询、失败和情绪不代表转人工；尚未恢复或询问是否恢复不代表已解决。',
      },
      invocation: {
        ...invocationSchema,
        description:
          '目标工具唯一且参数已知时提供Tool+Args，程序会直接校验执行。依赖上游结果才能确定参数时省略，不猜测。',
      },
      expected: {
        ...invocationSchema,
        description:
          '期望成功执行的工具与必须匹配的参数子集。填写用户明确的目标，例如update_requirements的budget=9000；未知值省略。未填时以invocation为准。',
      },
    },
    ['id', 'action', 'goal', 'sourceQuote', 'dependsOn'],
  ),
};

// 先验证完整图再发布到runtime，畸形计划不能执行任何业务工具。
export function parseExecutionPlan(
  value: unknown,
  message: string,
): ExecutionPlan {
  if (!Array.isArray(value) || !value.length)
    throw Error('执行计划必须包含动作节点');
  const nodes: ExecutionNode[] = value.map((entry) => {
    const n = parseObject(entry);
    rejectUnknownKeys(n, [
      'id',
      'action',
      'goal',
      'sourceQuote',
      'dependsOn',
      'catalogScope',
      'catalogPageSize',
      'otherTopic',
      'supportAction',
      'invocation',
      'expected',
    ]);
    const action = requestActions.find((a) => a === n.action);
    if (!action) throw Error('执行计划动作无效');
    if (
      n.catalogPageSize !== undefined &&
      (action !== 'search_catalog' ||
        typeof n.catalogPageSize !== 'number' ||
        !Number.isInteger(n.catalogPageSize) ||
        n.catalogPageSize < 1 ||
        n.catalogPageSize > 20)
    )
      throw Error('catalogPageSize必须为目录查询的1至20整数');
    if (
      n.catalogScope !== undefined &&
      (action !== 'search_catalog' ||
        (n.catalogScope !== 'page' && n.catalogScope !== 'all'))
    )
      throw Error('catalogScope仅允许目录查询使用page或all');
    const catalogScope =
      n.catalogScope === 'all'
        ? 'all'
        : n.catalogScope === 'page'
          ? 'page'
          : undefined;
    for (const key of ['id', 'goal', 'sourceQuote'])
      if (typeof n[key] !== 'string' || !n[key].trim())
        throw Error(`执行节点缺少${key}`);
    if (
      typeof n.id !== 'string' ||
      typeof n.goal !== 'string' ||
      typeof n.sourceQuote !== 'string'
    )
      throw Error('执行节点字段无效');
    if (!message.includes(n.sourceQuote))
      throw Error('执行节点必须引用当前用户原话');
    if (
      !Array.isArray(n.dependsOn) ||
      !n.dependsOn.every((id): id is string => typeof id === 'string')
    )
      throw Error('依赖必须是节点ID数组');
    const otherTopic =
      n.otherTopic === 'general' || n.otherTopic === 'support'
        ? n.otherTopic
        : undefined;
    const supportAction = supportActions.find((a) => a === n.supportAction);
    const parseCall = (value: unknown) => {
      if (value === undefined) return undefined;
      const call = parseObject(value);
      rejectUnknownKeys(call, ['tool', 'arguments']);
      if (
        typeof call.tool !== 'string' ||
        !toolMetadata[call.tool]?.primaryFor.includes(action)
      )
        throw Error('计划工具不属于当前任务的主工具，不能扩大操作权限');
      return { tool: call.tool, arguments: parseObject(call.arguments) };
    };
    const invocation = parseCall(n.invocation);
    const expected = parseCall(n.expected) ?? invocation;
    if (
      (action === 'other' && !otherTopic) ||
      (action !== 'other' && n.otherTopic !== undefined)
    )
      throw Error('otherTopic与节点动作不匹配');
    if (
      (action === 'update_support' && !supportAction) ||
      (action !== 'update_support' && n.supportAction !== undefined)
    )
      throw Error('supportAction与节点动作不匹配');
    return {
      id: n.id,
      action,
      goal: n.goal,
      sourceQuote: n.sourceQuote,
      dependsOn: n.dependsOn,
      catalogScope,
      catalogPageSize:
        typeof n.catalogPageSize === 'number' ? n.catalogPageSize : undefined,
      otherTopic,
      supportAction,
      status: 'pending',
      invocation,
      expected,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw Error('执行节点ID重复');
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error('执行计划存在循环依赖');
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw Error('执行计划引用不存在的依赖');
    visiting.add(id);
    node.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  nodes.forEach((n) => visit(n.id));
  if (
    nodes.some((n) => n.action === 'save_requirements') &&
    nodes.some((n) => n.action === 'recommend')
  )
    throw Error('只保存暂不生成与生成配置冲突，请澄清');
  // 局部替换沿用既有禁止整套重配边界。
  if (
    nodes.some((n) => n.action === 'replace_parts') &&
    nodes.some((n) =>
      ['recommend', 'save_requirements', 'clarify'].includes(n.action),
    )
  )
    throw Error('局部替换与需求重设不能在同轮混合，请澄清');
  const outgoing = new Map<string, number>();
  for (const node of nodes)
    for (const dependency of node.dependsOn)
      outgoing.set(dependency, (outgoing.get(dependency) ?? 0) + 1);
  const shape =
    nodes.length === 1
      ? 'single'
      : nodes.every((node) => !node.dependsOn.length)
        ? 'parallel'
        : nodes.filter((node) => !node.dependsOn.length).length === 1 &&
            nodes.every(
              (node) =>
                node.dependsOn.length <= 1 && (outgoing.get(node.id) ?? 0) <= 1,
            )
          ? 'sequential'
          : 'dag';
  return { nodes, factStart: 0, shape };
}

export function activeExecutionNode(runtime: ToolRuntime) {
  return runtime.executionPlan?.nodes.find(
    (n) => n.id === runtime.executionPlan?.activeId,
  );
}

export function advanceExecutionPlan(
  runtime: ToolRuntime,
  messageId: string,
  taskId: string,
) {
  const plan = runtime.executionPlan;
  if (!plan) return false;
  const byId = new Map(plan.nodes.map((n) => [n.id, n]));
  // 失败沿依赖边传播，无关节点仍可继续。
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of plan.nodes) {
      if (
        n.status === 'pending' &&
        n.dependsOn.some((id) => byId.get(id)?.status === 'blocked')
      ) {
        n.status = 'blocked';
        n.outcome = 'dependency_blocked';
        n.errorCode = 'DEPENDENCY_BLOCKED';
        n.reply = '前置操作未完成，本项未执行。';
        changed = true;
      }
    }
  }
  const node = plan.nodes.find(
    (n) =>
      n.status === 'pending' &&
      n.dependsOn.every((id) => byId.get(id)?.status === 'completed'),
  );
  plan.activeId = node?.id;
  if (!node) return false;
  node.status = 'running';
  plan.factStart = runtime.facts.length;
  runtime.requestAction = node.action;
  runtime.otherTopic = node.otherTopic;
  runtime.supportRequest = node.supportAction
    ? { action: node.supportAction, sourceMessageId: messageId, taskId }
    : undefined;
  runtime.requirementsTaskId = undefined;
  runtime.configurationTaskId = undefined;
  runtime.exploration = undefined;
  runtime.readOnlyEvaluationTurn = undefined;
  runtime.supportDelivery = undefined;
  return true;
}

export function executionPlanPrompt(runtime: ToolRuntime) {
  const node = activeExecutionNode(runtime);
  if (!node) return '';
  const summary = runtime.executionPlan?.nodes.map(
    ({ id, action, goal, dependsOn, status, outcome }) => ({
      id,
      action,
      goal,
      dependsOn,
      status,
      outcome,
    }),
  );
  return `\n本轮执行计划：${JSON.stringify(summary)}\n当前仅执行节点${node.id}：${node.goal}。引用原话：${node.sourceQuote}。当前调用及预期：${JSON.stringify({ invocation: node.invocation, expected: node.expected })}。其他节点由程序调度，不得提前执行或声称完成。保留用户完整消息中的否定和权限边界。完成后仅说明本节点工具事实，程序将继续后续节点。`;
}

export function executionPlanReply(plan: ExecutionPlan) {
  if (plan.nodes.length === 1) return plan.nodes[0].reply ?? '尚未执行。';
  return plan.nodes
    .map(
      (n) =>
        `${n.status === 'completed' ? '已处理' : '未完成'}：${n.goal}\n${n.reply ?? '尚未执行。'}`,
    )
    .join('\n\n');
}

export function matchesExpected(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, i) => matchesExpected(actual[i], value))
    );
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      return false;
    const values = actual as Record<string, unknown>;
    return Object.entries(expected).every(
      ([key, value]) =>
        Object.hasOwn(values, key) && matchesExpected(values[key], value),
    );
  }
  return actual === expected;
}

export function expectedResultPending(runtime: ToolRuntime) {
  const node = activeExecutionNode(runtime);
  if (node?.catalogScope === 'all' && !node.catalogProgress?.complete)
    return true;
  const expected = activeExecutionNode(runtime)?.expected;
  if (!expected) return false;
  const facts = runtime.facts.slice(runtime.executionPlan?.factStart ?? 0);
  if (
    !facts.some(
      (fact) =>
        !fact.failed &&
        fact.tool === expected.tool &&
        matchesExpected(fact.arguments, expected.arguments),
    )
  )
    return true;
  if (expected.tool === 'update_requirements') {
    const {
      rebuild: _rebuild,
      zeroBudgetConfirmationMessageId: _confirmation,
      ...patch
    } = expected.arguments;
    try {
      // 复用需求补丁语义，空字符串清除、去重和截断不能误判为未完成。
      const projected = applyDraft(runtime.draft, patch);
      return (
        !matchesExpected(runtime.draft, projected) ||
        !matchesExpected(projected, runtime.draft)
      );
    } catch {
      return true;
    }
  }
  if (expected.tool === 'select_plan') {
    return !matchesExpected(runtime.result?.selection, {
      ...(expected.arguments.planId
        ? { planId: expected.arguments.planId }
        : {}),
      ...(expected.arguments.confirm !== undefined
        ? { status: expected.arguments.confirm ? 'confirmed' : 'selected' }
        : {}),
    });
  }
  return false;
}
