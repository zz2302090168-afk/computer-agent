import type { Catalog, Category, PcTask } from '../domain/types';
import { completeRequirements } from '../agent/conversation-state';
import { assembleBuild, prepareRequirementAcceptance } from './recommend';
import type { RequirementAcceptance } from '../domain/requirement-acceptance';
import type { RequirementJudgeOptions } from '../agent/jev-requirements';
import { auditDelivery } from './delivery-audit';
import { isColorCategory } from '../rules/color';

// 只替换明确给出的ID；未涉及的配件不进入重新搜索。
function prepareEdit(
  task: PcTask,
  planId: string,
  replacements: { oldId: string; newId: string }[],
  catalog: Catalog,
  partColors: Partial<Record<Category, string>> = {},
) {
  const plan = task.result?.plans.find((item) => item.id === planId);
  if (!plan) throw Error('请明确要修改当前哪一套方案');
  if (plan.kind !== 'diy')
    throw Error('商家整机不能拆换配件；请明确同意转为DIY后再配置');
  if (
    !replacements.length ||
    replacements.length > 8 ||
    new Set(replacements.map((item) => item.oldId)).size !== replacements.length
  )
    throw Error('请提供一到八项不重复的配件替换');
  const changed = new Set<Category>();
  const draft = structuredClone(task.draft);
  draft.partPreferences ??= {};
  draft.seriesPreferences ??= {};
  draft.brandPreferences ??= {};
  draft.partColors ??= {};
  const ids = plan.parts.map((part) => part.id);
  for (const replacement of replacements) {
    const old = plan.parts.find((part) => part.id === replacement.oldId);
    const next = catalog.parts.find((part) => part.id === replacement.newId);
    if (!old || !next || old.category !== next.category)
      throw Error('替换商品不存在或类别不一致');
    if (old.id === next.id) throw Error('新旧配件相同，无需替换');
    changed.add(old.category);
    ids[ids.indexOf(old.id)] = next.id;
    draft.partPreferences[old.category] = next.id;
    delete draft.seriesPreferences[old.category];
    delete draft.brandPreferences[old.category];
  }
  for (const [category, color] of Object.entries(partColors)) {
    if (
      !changed.has(category as Category) ||
      !isColorCategory(category) ||
      !['黑色', '白色', '不限', '黑色优先，白色备选'].includes(color)
    )
      throw Error('颜色调整只能用于本次明确替换的类别');
    draft.partColors[category as Category] = color;
  }
  const requirements = completeRequirements(draft);
  return { task, plan, changed, draft, ids, requirements, catalog };
}
function finishEdit(
  prepared: ReturnType<typeof prepareEdit>,
  acceptance?: RequirementAcceptance,
) {
  const { task, plan, changed, draft, ids, requirements, catalog } = prepared;
  const candidate = assembleBuild(
    ids,
    requirements,
    catalog.parts,
    catalog.prebuilts,
    acceptance,
  );
  const updated = auditDelivery(
    [{ ...candidate, id: plan.id }],
    requirements,
    catalog,
  )[0]!;
  draft.partSelections = Object.fromEntries(
    updated.parts.map((part) => [part.category, part.id]),
  );
  draft.selectionSources = Object.fromEntries(
    updated.parts.map((part) => [
      part.category,
      changed.has(part.category) || draft.partPreferences?.[part.category]
        ? 'user'
        : 'assistant',
    ]),
  );
  draft.selectionConfirmationMessageIds = {};
  return {
    ...task,
    draft,
    issues: [],
    result: {
      ...task.result!,
      selection: undefined,
      requirements: completeRequirements(draft),
      plans: [updated],
      evaluation: undefined,
      explanation: null,
      summary: `已替换 ${changed.size} 项配件，其余 ${8 - changed.size} 项保持不变，并重新审核报价与兼容性。`,
      budgetDiagnostic: {
        status: updated.budget.status,
        minimumReference: updated.budget.minimumReference,
        highReference: updated.budget.highReference,
        reason: updated.budget.reason,
        searchComplete: true,
      },
    },
  } satisfies PcTask;
}

export function editPlan(...args: Parameters<typeof prepareEdit>) {
  return finishEdit(prepareEdit(...args));
}
export async function editPlanAsync(
  args: Parameters<typeof prepareEdit>,
  options: RequirementJudgeOptions = {},
) {
  const prepared = prepareEdit(...args);
  const { ids, requirements, catalog } = prepared;
  const acceptance = await prepareRequirementAcceptance(
    ids,
    requirements,
    catalog.parts,
    catalog.prebuilts,
    undefined,
    options,
  );
  return finishEdit(prepared, acceptance);
}
