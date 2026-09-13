import { completeRequirements } from '../../agent/conversation-state';
import { assembleBuild } from '../../services/recommend';
import { validateBuild } from '../../rules/compatibility';
import type { Plan } from '../../domain/types';
import {
  objectSchema,
  parseObject,
  rejectUnknownKeys,
  type RegisteredTool,
  ToolExecutionError,
} from '../types';
import { saveSelectedPlan } from './selection';
export const assembleBuildTool: RegisteredTool = {
  definition: {
    type: 'function',
    function: {
      name: 'assemble_build',
      description:
        '提交自主挑选的八类商品 ID。服务端重读数据库、重新计价并校验完整性、需求、预算和兼容性。整机模式不可调用。',
      parameters: objectSchema(
        {
          productIds: {
            type: 'array',
            items: { type: 'string' },
            minItems: 8,
            maxItems: 8,
          },
        },
        ['productIds'],
      ),
    },
  },
  async execute(value, context, runtime) {
    const input = parseObject(value);
    rejectUnknownKeys(input, ['productIds']);
    if (
      !Array.isArray(input.productIds) ||
      input.productIds.length !== 8 ||
      !input.productIds.every((id) => typeof id === 'string' && id)
    )
      throw Error('productIds 必须包含八个商品 ID');
    const requirements = completeRequirements(runtime.draft);
    // 模型只提交 ID；价格、规格与总价都从最新数据库记录重新计算。
    context.catalog = await context.reloadCatalog();
    let plan: Plan;
    try {
      plan = assembleBuild(
        input.productIds,
        requirements,
        context.catalog.parts,
        context.catalog.prebuilts,
      );
    } catch (cause) {
      const ids = input.productIds as string[];
      const selected = context.catalog.parts.filter((part) =>
        ids.includes(part.id),
      );
      const conflicts = selected.flatMap((part, i) =>
        selected.slice(i + 1).flatMap((other) => {
          const check = validateBuild([part, other], true);
          return check.status === 'fail'
            ? [
                {
                  productIds: [part.id, other.id],
                  categories: [part.category, other.category],
                  issues: check.issues,
                },
              ]
            : [];
        }),
      );
      throw new ToolExecutionError(
        cause instanceof Error ? cause.message : '组装未通过校验',
        {
          code: conflicts.length
            ? 'compatibility_conflict'
            : 'constraint_rejected',
          productIds: input.productIds,
          conflicts,
          retryable: true,
          guidance:
            '根据具体冲突自行查询相关类别的其他候选并重试，保留预算、型号与颜色要求；不得将单个组合失败说成目录无解',
        },
      );
    }
    return saveSelectedPlan(plan, requirements, context, runtime);
  },
};
