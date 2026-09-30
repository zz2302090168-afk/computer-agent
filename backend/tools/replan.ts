import {
  activeExecutionNode,
  advanceExecutionPlan,
  invocationSchema,
  matchesExpected,
  parseExecutionPlan,
} from '../agent/execution-plan';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
  type ToolRuntime,
} from './types';

export function canReplan(runtime: ToolRuntime) {
  const plan = runtime.executionPlan;
  return (
    (plan?.nodes.length ?? 0) > 1 &&
    !!activeExecutionNode(runtime) &&
    (plan?.replans ?? 0) < 1 &&
    !runtime.facts
      .slice(plan?.factStart ?? 0)
      .some(
        (fact) =>
          !fact.failed &&
          !['set_request_action', 'revise_execution_plan'].includes(fact.tool),
      ) &&
    runtime.facts
      .slice(plan?.factStart ?? 0)
      .some(
        (fact) =>
          fact.failed && !fact.rejected && fact.tool !== 'set_request_action',
      )
  );
}

export const reviseExecutionPlanTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'revise_execution_plan',
      description:
        '工具已报告失败且确需调整后续步骤时，在原用户授权内修订未完成节点的依赖或Tool+Args。整轮最多一次；不能增删任务、改动作/目标/预期结果或重跑已完成节点，不重置候选和模型额度。普通参数修正仍可直接调用原工具，无需重规划。',
      parameters: objectSchema(
        {
          reason: { type: 'string' },
          revisions: {
            type: 'array',
            minItems: 1,
            items: objectSchema(
              {
                id: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'string' } },
                invocation: invocationSchema,
              },
              ['id', 'dependsOn'],
            ),
          },
        },
        ['reason', 'revisions'],
      ),
    },
  },
  async execute(value, context, runtime) {
    if (!canReplan(runtime))
      throw Error('仅当前节点有失败事实且未使用重规划额度时允许修订');
    const input = parseObject(value);
    rejectUnknownKeys(input, ['reason', 'revisions']);
    if (
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      !Array.isArray(input.revisions) ||
      !input.revisions.length
    )
      throw Error('重规划需要原因和非空修订列表');
    const plan = runtime.executionPlan!;
    const edits = new Map<string, Record<string, unknown>>();
    for (const entry of input.revisions) {
      const edit = parseObject(entry);
      rejectUnknownKeys(edit, ['id', 'dependsOn', 'invocation']);
      const node = plan.nodes.find((n) => n.id === edit.id);
      if (
        !node ||
        !['pending', 'running'].includes(node.status) ||
        edits.has(node.id)
      )
        throw Error('不能修改已结束、重复或不存在的节点');
      if (edit.invocation !== undefined && node.expected) {
        const call = parseObject(edit.invocation);
        if (
          call.tool !== node.expected.tool ||
          !matchesExpected(call.arguments, node.expected.arguments)
        )
          throw Error('重规划不能降低或更改原预期目标');
      }
      edits.set(node.id, edit);
    }
    const source = context.messages.find(
      (m) => m.id === context.currentMessageId && m.role === 'user',
    );
    if (!source) throw Error('当前用户消息缺失');
    const revised = parseExecutionPlan(
      plan.nodes.map((node) => ({
        id: node.id,
        action: node.action,
        goal: node.goal,
        sourceQuote: node.sourceQuote,
        catalogScope: node.catalogScope,
        catalogPageSize: node.catalogPageSize,
        dependsOn: node.dependsOn,
        otherTopic: node.otherTopic,
        supportAction: node.supportAction,
        invocation: node.invocation,
        expected: node.expected,
        ...edits.get(node.id),
      })),
      source.content,
    );
    revised.replans = (plan.replans ?? 0) + 1;
    revised.nodes.forEach((node, index) => {
      const old = plan.nodes[index];
      if (old.status !== 'running')
        Object.assign(node, {
          status: old.status,
          catalogProgress: old.catalogProgress,
          reply: old.reply,
          outcome: old.outcome,
          errorCode: old.errorCode,
          directAttempted: edits.has(old.id) ? false : old.directAttempted,
        });
    });
    runtime.executionPlan = revised;
    advanceExecutionPlan(runtime, context.currentMessageId, context.taskId);
    return { reason: input.reason, plan: revised };
  },
};
