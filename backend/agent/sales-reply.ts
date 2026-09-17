import type {
  RecommendationResult,
  PlanEvaluation,
  Plan,
} from '../domain/types';
import { labels } from '../domain/types';
import type { findReplacements } from '../services/find-replacements';

/** 只呈现程序确认的对象拒绝，不将模型文字当成失败事实。 */
export function selectionRefusalReply(output: unknown): string | undefined {
  if (
    !output ||
    typeof output !== 'object' ||
    !('operation' in output) ||
    !('observation' in output)
  )
    return;
  const op = output.operation;
  if (
    !op ||
    typeof op !== 'object' ||
    !('tool' in op) ||
    op.tool !== 'select_plan' ||
    !('failed' in op) ||
    op.failed !== true
  )
    return;
  let observation = output.observation;
  if (
    observation &&
    typeof observation === 'object' &&
    'repeated' in observation &&
    observation.repeated === true &&
    'previous' in observation
  ) {
    const previous = observation.previous;
    if (previous && typeof previous === 'object' && 'observation' in previous)
      observation = previous.observation;
  }
  if (
    !observation ||
    typeof observation !== 'object' ||
    !('code' in observation) ||
    observation.code !== 'selection_target_invalid' ||
    !('reason' in observation) ||
    typeof observation.reason !== 'string'
  )
    return;
  return `这次选定或确认操作未执行，未因该失败改变当前方案或确认状态。${observation.reason}`;
}

export function selectionReply(result: RecommendationResult) {
  const selection = result.selection;
  const plan = result.plans.find((item) => item.id === selection?.planId);
  if (!selection || !plan) return;
  return [
    selection.status === 'confirmed'
      ? `已确认当前主机方案，总价¥${plan.total}。`
      : `已选定当前主机方案继续讨论，总价¥${plan.total}，尚未确认购买。`,
    plan.budget.reason,
    plan.demo || plan.parts.some((part) => part.demo)
      ? `此方案包含演示商品，型号与报价仅供演示。${plan.parts
          .filter((part) => part.demo)
          .map(
            (part) =>
              `${labels[part.category]}：${part.brand} ${part.name}（演示商品）`,
          )
          .join('；')}`
      : '',
    plan.kind === 'prebuilt'
      ? '这是商家整机，未执行DIY配件兼容性审核。'
      : plan.validation.status === 'unknown'
        ? '部分兼容资料仍待核对，不能视为兼容性已全部验证。'
        : '已录入的兼容规则检查结果见配置工作区。',
    ...plan.validation.issues,
    '完整八类配件及报价见配置工作区。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function replacementPreviewReply(
  result: ReturnType<typeof findReplacements>,
) {
  return [
    '以下是换件预览，尚未修改当前方案。价格差异不能证明性能相同。',
    ...result.categories
      .filter((item) => item.priceRelation === 'cheaper')
      .map(
        (item) =>
          `${labels[item.category]}候选价格须严格低于当前配件¥${item.oldPrice}，不包含同价或更贵型号。`,
      ),
    result.totalPriceRelation === 'cheaper'
      ? `组合替换后主机总价须严格低于当前¥${result.oldTotal}；个别配件可以涨价。`
      : '',
    ...result.candidates.map((candidate) =>
      [
        candidate.parts
          .map(
            (part) =>
              `${labels[part.category]}：${part.name}（商品ID ${part.id}），¥${part.price}${part.demo ? '（演示商品）' : ''}${['cpu', 'storage'].includes(part.category) ? '' : `，${part.color}`}`,
          )
          .join('；'),
        `替换后整套¥${candidate.total}，比原方案${candidate.difference < 0 ? `减少¥${-candidate.difference}` : candidate.difference > 0 ? `增加¥${candidate.difference}` : '价格不变'}`,
        candidate.validation.status === 'unknown' ? '兼容资料仍待核对' : '',
      ]
        .filter(Boolean)
        .join('。'),
    ),
    ...Array.from(
      new Set(
        result.candidates.flatMap((candidate) => candidate.validation.issues),
      ),
    ).map((issue) => `候选待核对项：${issue}`),
    Object.keys(result.proposedPartColors).length
      ? `以上预览采用配色条件：${Object.entries(result.proposedPartColors)
          .map(
            ([category, color]) =>
              `${labels[category as keyof typeof labels]}${color}`,
          )
          .join('、')}；改变现有配色须经你同意后才会实际替换。`
      : '',
    !result.candidates.length
      ? '本页没有通过审核的候选，不能据此断言整个目录都没有。'
      : '',
    ...result.rejected.map((item) => `未通过：${item.reason}`),
    result.nextOffset !== null
      ? '还有后续待审核组合，可继续查询下一页；不代表后续一定有满足价格和兼容条件的候选。'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function replacementReply(before: Plan, after: Plan) {
  return [
    '已完成局部替换，以下为实际更新结果：',
    ...after.parts
      .filter((part) => !before.parts.some((old) => old.id === part.id))
      .map(
        (part) =>
          `${labels[part.category]}：${part.brand} ${part.name}，¥${part.price}${part.demo ? '（演示商品）' : ''}。`,
      ),
    `整套总价从¥${before.total}变为¥${after.total}。${after.budget.reason}`,
    after.validation.status === 'unknown'
      ? '部分兼容资料仍待核对，不能宣称兼容性已全部验证。'
      : '已录入的兼容规则检查结果见配置工作区。',
    ...after.validation.issues,
  ].join('\n\n');
}

export function recommendationReply(result: RecommendationResult) {
  if (!result.plans.length) return result.summary;
  return [
    result.summary,
    ...result.plans.map((plan, index) => {
      const core = plan.parts
        .filter((p) => p.category === 'cpu' || p.category === 'gpu')
        .map((p) => `${p.brand} ${p.name}`)
        .join(' + ');
      return `方案${index + 1}：¥${plan.total}，${core}。${plan.demo ? '包含演示商品，型号与报价仅供演示。' : ''}${plan.budget.reason}${plan.budget.confirmable ? '' : '该参考不能确认购买。'}`;
    }),
    result.plans.some((p) => p.validation.status === 'unknown')
      ? '部分兼容资料仍待核对，不能视为已经全部验证。具体配件和待核对项见配置工作区。'
      : '具体八类配件及报价见配置工作区。',
    result.plans.some((p) => p.kind === 'prebuilt')
      ? '商家整机未执行DIY兼容性审核。'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function evaluationReply(evaluation: PlanEvaluation) {
  return [
    '已评估当前指定方案。',
    ...evaluation.directions,
    ...evaluation.issues.map((issue) => `待核对：${issue}`),
    ...evaluation.suggestions.map(
      (s) =>
        `${s.summary}。${s.reason}。${s.valid ? '这是候选建议，尚未执行替换；价差不能证明性能相同。' : '该建议不能直接执行。'}`,
    ),
  ].join('\n\n');
}

export function explanationReply(
  plan: Plan,
  selected: Plan['parts'],
  budget: number,
) {
  return [
    ...selected.map((part) => {
      const share =
        plan.total > 0
          ? `，占该方案总价的${((part.price / plan.total) * 100).toFixed(1)}%`
          : '';
      const specs = [
        ['socket', '插槽'],
        ['ddr', '内存代际'],
        ['form', '规格尺寸类型'],
        ['capacity', '容量'],
        ['watts', '功率'],
      ].flatMap(([key, label]) =>
        typeof part.specs[key] === 'string' ||
        typeof part.specs[key] === 'number'
          ? [`${label}：${part.specs[key]}`]
          : [],
      );
      return `${part.brand} ${part.name}，目录价¥${part.price}${part.demo ? '（演示商品）' : ''}${share}。${['cpu', 'storage'].includes(part.category) ? '此类别不参与配色。' : `目录配色为${part.color}。`}${specs.length ? `目录记录${specs.join('，')}；录入资料不等于厂家逐项确认。` : ''}`;
    }),
    `这套方案的预算为¥${budget}，总价¥${plan.total}。${plan.budget.reason}。这些是目录与约束依据，不能证明该型号性能最优或是唯一选择。`,
    plan.kind === 'prebuilt'
      ? '这是商家整机，未执行DIY配件兼容性审核。'
      : plan.validation.status === 'unknown'
        ? '已知规则用于初筛，以下资料仍需核对，不能宣称兼容性已全部验证：'
        : '已录入的兼容规则检查结果见配置工作区。',
    ...plan.validation.issues,
  ].join('\n\n');
}

// 仅接受本地业务工具生成的正文；模型自由文字不能声明自己的交付凭证。
export function completedSalesReply(output: unknown): string | undefined {
  if (
    !output ||
    typeof output !== 'object' ||
    !('operation' in output) ||
    !('data' in output)
  )
    return;
  const op = output.operation,
    data = output.data;
  if (
    !op ||
    typeof op !== 'object' ||
    !('failed' in op) ||
    op.failed !== false ||
    !('tool' in op) ||
    typeof op.tool !== 'string' ||
    ![
      'recommend_pc',
      'evaluate_plan',
      'explain_selection',
      'find_replacements',
      'replace_parts',
      'select_plan',
      'answer_knowledge',
      'search_catalog',
    ].includes(op.tool)
  )
    return;
  if (
    data &&
    typeof data === 'object' &&
    'displayReply' in data &&
    typeof data.displayReply === 'string'
  )
    return data.displayReply;
}
