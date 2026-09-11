import { selectPlan } from '../../services/select-plan';
import { assertCurrentTaskUserMessage } from '../requirements';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
} from '../types';

export const selectPlanTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'select_plan',
      description:
        '用户选定已生成的某套配置时保存当前方案，供后续解释、评估和修改使用。不重新选型。confirm默认为false；只有用户明确确认这套主机时设true，且须通过最新交付审核。',
      parameters: objectSchema(
        {
          planId: { type: 'string' },
          sourceMessageId: { type: 'string' },
          confirm: { type: 'boolean' },
        },
        ['planId', 'sourceMessageId'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['planId', 'sourceMessageId', 'confirm']);
    if (
      typeof input.planId !== 'string' ||
      !input.planId ||
      (input.confirm !== undefined && typeof input.confirm !== 'boolean')
    )
      throw Error('选择方案参数无效');
    assertCurrentTaskUserMessage(context, input.sourceMessageId);
    if (input.sourceMessageId !== context.currentMessageId)
      throw Error('选择方案必须依据当前用户消息');
    context.catalog = await context.reloadCatalog();
    const next = selectPlan(
      { ...runtime.task, draft: runtime.draft, result: runtime.result },
      input.planId,
      context.catalog,
      { source: 'user_message', messageId: input.sourceMessageId as string },
      input.confirm === true,
    );
    const version = await context.onUpdate?.('plan', next.draft, next.result);
    runtime.draft = next.draft;
    runtime.result = next.result;
    runtime.task = { ...next, version: version ?? next.version };
    return {
      selection: next.result!.selection,
      summary: next.result!.summary,
      version,
    };
  },
};
