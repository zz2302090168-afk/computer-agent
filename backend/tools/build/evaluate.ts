import { evaluatePlan } from '../../services/evaluate';
import { resolvePlan } from '../../services/resolve-plan';
import { completeRequirements } from '../../agent/conversation-state';
import { evaluationReply } from '../../agent/sales-reply';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const evaluatePlanTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'evaluate_plan',
      description:
        '评估已指定、已选定或唯一方案，返回问题、调整方向、证据和候选比较；多套未选定会要求选择。只保存评估结果，不替换配件或重新推荐。',
      parameters: objectSchema({
        planId: { type: 'string' },
        candidateProductId: { type: 'string' },
        focus: { type: 'string' },
      }),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['planId', 'candidateProductId', 'focus']);
    for (const key of ['planId', 'candidateProductId', 'focus'])
      if (input[key] !== undefined && typeof input[key] !== 'string')
        throw Error(`${key} 必须是字符串`);
    if (!runtime.result) throw Error('当前任务没有可评估方案');
    runtime.readOnlyEvaluationTurn = true;
    if (
      !input.planId &&
      !runtime.result.selection &&
      runtime.result.plans.length > 1
    ) {
      runtime.pendingEvaluation = {
        planIds: runtime.result.plans.map((plan) => plan.id),
      };
      resolvePlan(runtime.result);
    }
    context.catalog = await context.reloadCatalog();
    const evaluation = await evaluatePlan(
      runtime.result,
      context.catalog,
      completeRequirements(runtime.draft),
      input as { planId?: string; candidateProductId?: string; focus?: string },
      context.embeddingConfig ?? {},
      context.signal,
    );
    const result = { ...runtime.result, evaluation };
    await context.onUpdate?.('evaluation', runtime.draft, result);
    runtime.result = result;
    runtime.knowledgeUnavailable ||=
      evaluation.knowledgeStatus === 'unavailable';
    runtime.pendingEvaluation = undefined;
    runtime.toolsUsed.push('评估方案');
    return { ...evaluation, displayReply: evaluationReply(evaluation) };
  },
};
