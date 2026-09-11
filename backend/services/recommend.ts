import {
  labels,
  type Part,
  type Category,
  type Plan,
  type Prebuilt,
  type Requirements,
} from '../domain/types';
import {
  budgetRange,
  budgetStatus,
  withinBudget,
  recommendationTargets,
} from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import { matchesRequirementColor, requiredPartColor } from '../rules/color';
import { createBuildSearch } from './build-search';
import {
  calculateQuote,
  matchesModel,
  searchPrebuiltCatalog,
} from './catalog-search';
import { purposeBudgetWeights as weights } from './selection-policy';
function matchesSeries(name: string, series?: string) {
  if (!series) return true;
  if (
    /^(?:geforce\s+)?(?:rtx\s*)?\d{4}(?:\s*(?:ti|super|ti super))?$/i.test(
      series.trim(),
    )
  )
    return matchesModel(name, series);
  const normalized = name.toUpperCase().replace(/\s+/g, ' '),
    wanted = series.toUpperCase().replace(/\s+/g, ' ');
  return normalized.includes(wanted);
}
function candidatesByCategory(r: Requirements, parts: Part[]) {
  return Object.keys(labels).map((category) =>
    parts
      .filter(
        (p) =>
          p.category === category &&
          Number.isFinite(p.price) &&
          p.price >= 0 &&
          (!r.partPreferences?.[category as Category] ||
            p.id === r.partPreferences[category as Category]) &&
          matchesSeries(p.name, r.seriesPreferences?.[category as Category]) &&
          (!r.brandPreferences?.[category as Category] ||
            p.brand
              .toLowerCase()
              .includes(
                r.brandPreferences[category as Category]!.toLowerCase(),
              )) &&
          matchesRequirementColor(p, r, parts),
      )
      .sort((a, b) => a.price - b.price),
  );
}
type FailureKind =
  | 'missing_products'
  | 'known_conflict'
  | 'search_insufficient'
  | 'budget_gap';
type RecommendationFailure = {
  kind: FailureKind;
  searchComplete: boolean;
  reason: string;
};
type DiyReferences = {
  searchComplete: boolean;
  kind?: FailureKind;
  minimum?: number;
  high?: number;
  minimumParts?: Part[];
  highParts?: Part[];
  highBasis?: string;
};
function calculateDiyReferences(
  groups: Part[][],
  search: ReturnType<typeof createBuildSearch>,
): DiyReferences {
  if (groups.some((group) => !group.length))
    return { searchComplete: true, kind: 'missing_products' };
  const minimum = search({ goal: 'minimum' });
  if (!minimum.searchComplete)
    return { searchComplete: false, kind: 'search_insufficient' };
  const low = minimum.solutions[0];
  if (!low) return { searchComplete: true, kind: 'known_conflict' };
  const maximum = search({ goal: 'maximum' });
  const high = maximum.solutions[0];
  if (!maximum.searchComplete || !high)
    return { searchComplete: false, kind: 'search_insufficient' };
  return {
    searchComplete: true,
    minimum: low.total,
    minimumParts: low.parts,
    high: high.total,
    highParts: high.parts,
    highBasis:
      '目录内满足当前约束的实际最高完整兼容配置总价；这是商家目录上限，不代表实测性能最高',
  };
}
export function findDiyBudgetReferences(
  r: Requirements,
  parts: Part[],
): DiyReferences {
  const groups = candidatesByCategory(r, parts);
  return calculateDiyReferences(groups, createBuildSearch(groups));
}
function assessBudget(
  total: number,
  r: Requirements,
  references: { minimum: number; high: number },
  highBasis: string,
) {
  const status = budgetStatus(r.budget, references),
    range = budgetRange(r.budget, r.hardCap, references, r.budgetTolerance);
  return {
    status,
    difference: total - r.budget,
    confirmable: status !== 'below_minimum_reference',
    label:
      status === 'below_minimum_reference'
        ? '超预算参考'
        : status === 'above_high_reference'
          ? total === references.high
            ? '目录最高参考'
            : '高预算可用方案'
          : '符合预算',
    reason:
      status === 'below_minimum_reference'
        ? `预算低于最低完整配置，当前仅展示超预算参考，超出 ¥${total - r.budget}`
        : status === 'above_high_reference'
          ? total === references.high
            ? `预算高于目录最高完整兼容参考，允许节省；${highBasis}`
            : '当前方案在预算内且通过已知约束校验，未达到目录最高总价，不能称为最贵或性能最强'
          : `总价位于预算允许区间 ¥${range.min}～¥${range.max}`,
    minimumReference: references.minimum,
    highReference: references.high,
    highReferenceBasis: highBasis,
  };
}
// 工具消费同一次搜索的方案与诊断，空结果不再重新搜索或猜测原因。
export function recommendDetailed(
  r: Requirements,
  parts: Part[],
  pcs: Prebuilt[],
): { plans: Plan[]; failure?: RecommendationFailure } {
  const range = budgetRange(r.budget, r.hardCap, undefined, r.budgetTolerance);
  const groups = candidatesByCategory(r, parts);
  const search = createBuildSearch(groups);
  const diy =
    r.mode === 'prebuilt' ? undefined : calculateDiyReferences(groups, search);
  const fail = (kind: FailureKind, reason: string, searchComplete = true) => ({
    plans: [] as Plan[],
    failure: { kind, reason, searchComplete },
  });
  if (diy && !diy.searchComplete)
    return fail(
      'search_insufficient',
      '搜索达到计算上限，尚未确认目录最低或最高配置；不能据此判断无解',
      false,
    );

  const allowedIds = new Set(groups.flat().map((part) => part.id));
  const byId = new Map(parts.map((part) => [part.id, part]));
  const matchingPcs =
    r.mode === 'diy'
      ? []
      : searchPrebuiltCatalog(pcs, r)
          .filter(
            (pc) =>
              Number.isFinite(pc.price) &&
              pc.price >= 0 &&
              pc.partIds.length === Object.keys(labels).length &&
              pc.partIds.every((id) => allowedIds.has(id)),
          )
          .map((pc) => ({ pc, parts: pc.partIds.map((id) => byId.get(id)!) }));
  const eligiblePcs = matchingPcs
    .filter(
      (entry) =>
        new Set(entry.pc.partIds).size === Object.keys(labels).length &&
        new Set(entry.parts.map((part) => part.category)).size ===
          Object.keys(labels).length,
    )
    .sort((a, b) => a.pc.price - b.pc.price);
  const lowPc = eligiblePcs[0];
  const highPc = eligiblePcs[eligiblePcs.length - 1];
  const minimum = Math.min(
    diy?.minimum ?? Infinity,
    lowPc?.pc.price ?? Infinity,
  );
  const high = Math.max(diy?.high ?? -Infinity, highPc?.pc.price ?? -Infinity);
  if (!Number.isFinite(minimum) || !Number.isFinite(high)) {
    const missingColors = Object.entries(labels)
      .filter(
        ([category]) =>
          parts.some((part) => part.category === category) &&
          !parts.some(
            (part) =>
              part.category === category &&
              matchesRequirementColor(part, r, parts),
          ),
      )
      .map(
        ([category, label]) =>
          `${label}（${r.partColors?.[category as Category] ?? r.color}）`,
      );
    if (missingColors.length)
      return fail(
        'missing_products',
        '当前目录缺少符合颜色要求的' +
          missingColors.join('、') +
          '；不能用其他颜色冒充，请补充商品或明确调整配色要求',
      );
    const conflict = diy?.kind === 'known_conflict' || matchingPcs.length > 0;
    return conflict
      ? fail(
          'known_conflict',
          '符合商品约束的候选中，没有通过已知兼容性检查的完整配置',
        )
      : fail(
          'missing_products',
          '当前型号、品牌、颜色或购买方式约束下，缺少完整配置所需的数据库商品',
        );
  }
  const references = { minimum, high };
  const status = budgetStatus(r.budget, references);
  const highBasis =
    highPc?.pc.price === high
      ? '目录内满足当前约束的实际最高完整整机售价；不代表实测性能最高'
      : diy!.highBasis!;
  const cats = Object.keys(labels);
  const w = weights[r.purpose] || weights.游戏;
  const priority = (part: Part) => {
    const target = r.budget * w[cats.indexOf(part.category)]!;
    return Math.abs(part.price - target) / Math.max(1, target);
  };
  const make = (
    ps: Part[],
    kind: 'diy' | 'prebuilt',
    id: string,
    name: string,
    total: number,
  ): Plan => ({
    id,
    kind,
    name,
    parts: ps,
    total,
    score:
      ps.reduce((sum, part) => sum + priority(part), 0) +
      (Math.abs(total - r.budget) / r.budget) * 4,
    validation:
      kind === 'prebuilt'
        ? { status: 'not_applicable', issues: [] }
        : validateBuild(ps),
    reason:
      (r.color === '黑色优先，白色备选'
        ? '按类别优先黑色，仅目录没有黑色的类别使用白色。'
        : '') +
      '按' +
      r.purpose +
      '用途选择数据库商品；' +
      (kind === 'diy'
        ? '总价为八类配件目录价之和，不含代装和显示器。'
        : '总价使用数据库整机售价，配件行价仅作构成参考。') +
      '用途价格比例仅用于候选排序，不代表实测性能；' +
      (kind === 'prebuilt'
        ? '商家整机作为目录中的完整商品处理，不执行DIY配件兼容性审核。'
        : '未知兼容项目仍需核实。'),
    budget: assessBudget(total, r, references, highBasis),
  });
  if (status !== 'standard') {
    const low = status === 'below_minimum_reference';
    const target = low ? minimum : high;
    const diyTotal = low ? diy?.minimum : diy?.high;
    const diyParts = low ? diy?.minimumParts : diy?.highParts;
    if (diyTotal === target && diyParts)
      return {
        plans: [
          make(
            diyParts,
            'diy',
            low ? 'diy-minimum-reference' : 'diy-high-reference',
            low ? '最低完整配置参考' : '目录最高参考',
            target,
          ),
        ],
      };
    const pc = (low ? lowPc : highPc)!;
    return {
      plans: [make(pc.parts, 'prebuilt', pc.pc.id, pc.pc.name, pc.pc.price)],
    };
  }

  const targets = recommendationTargets(r.budget, r.hardCap, r.budgetTolerance);
  const candidates: Plan[] = [];
  let searchComplete = true;
  if (diy?.minimum !== undefined) {
    const goals = r.preferExpensive
      ? (['maximum'] as const)
      : r.preferCheaper
        ? (['minimum'] as const)
        : (['budget'] as const);
    const exclude = new Set<string>();
    for (const target of r.preferExpensive || r.preferCheaper
      ? [r.budget]
      : targets) {
      for (const goal of goals) {
        const result = search({
          goal,
          range,
          target,
          priority,
          exclude,
        });
        searchComplete &&= result.searchComplete;
        candidates.push(
          ...result.solutions.map((build) => {
            const key = build.parts
              .map((part) => part.id)
              .sort()
              .join('|');
            exclude.add(key);
            return make(
              build.parts,
              'diy',
              'diy-' + key,
              r.preferExpensive
                ? '约束内最高价方案'
                : r.preferCheaper
                  ? '预算节省方案'
                  : '用途匹配方案',
              build.total,
            );
          }),
        );
      }
    }
  }
  if (r.preferExpensive && !searchComplete)
    return fail(
      'search_insufficient',
      '搜索达到计算上限，尚未确认当前约束内的最高价方案',
      false,
    );
  for (const entry of eligiblePcs)
    if (
      withinBudget(
        entry.pc.price,
        r.budget,
        r.hardCap,
        undefined,
        r.budgetTolerance,
      )
    )
      candidates.push(
        make(
          entry.parts,
          'prebuilt',
          entry.pc.id,
          entry.pc.name,
          entry.pc.price,
        ),
      );
  if (!candidates.length)
    return searchComplete
      ? fail(
          'budget_gap',
          '完整搜索后，当前约束下没有总价位于 ¥' +
            range.min +
            '～¥' +
            range.max +
            ' 的配置',
        )
      : fail(
          'search_insufficient',
          '搜索达到计算上限，尚未找到预算区间内的配置；不能据此断言无解',
          false,
        );
  const compare = (a: Plan, b: Plan) =>
    r.preferExpensive
      ? b.total - a.total
      : r.preferCheaper
        ? a.total - b.total
        : a.score - b.score;
  if (r.preferCheaper || r.preferExpensive)
    return { plans: candidates.sort(compare).slice(0, 1) };
  const selected: Plan[] = [];
  for (const [index, target] of targets.entries()) {
    const min = index === 0 ? range.min : (targets[index - 1]! + target) / 2;
    const max =
      index === targets.length - 1
        ? range.max
        : (target + targets[index + 1]!) / 2;
    const plan = candidates
      .filter(
        (plan) =>
          plan.total >= min &&
          plan.total <= max &&
          !selected.some((other) => other.id === plan.id),
      )
      .sort(
        (a, b) =>
          Math.abs(a.total - target) - Math.abs(b.total - target) ||
          a.score - b.score,
      )[0];
    if (plan) selected.push(plan);
  }
  return { plans: selected };
}
export function recommend(
  r: Requirements,
  parts: Part[],
  pcs: Prebuilt[],
): Plan[] {
  return recommendDetailed(r, parts, pcs).plans;
}
export function selectPrebuilt(
  id: string,
  r: Requirements,
  parts: Part[],
  pcs: Prebuilt[],
): Plan {
  if (r.mode === 'diy') throw Error('当前要求DIY，不能改选商家整机');
  const pc = searchPrebuiltCatalog(pcs, r).find((item) => item.id === id);
  if (!pc) throw Error('整机不存在或不符合品牌、机箱颜色要求');
  const allowed = new Set(
    candidatesByCategory(r, parts)
      .flat()
      .map((part) => part.id),
  );
  if (pc.partIds.some((partId) => !allowed.has(partId)))
    throw Error(
      '整机配件不符合指定型号、系列、品牌或整套配色要求，请查询其他整机',
    );
  const selected = pc.partIds.map((partId) =>
    parts.find((part) => part.id === partId)!,
  );
  if (
    pc.partIds.length !== Object.keys(labels).length ||
    new Set(pc.partIds).size !== Object.keys(labels).length ||
    new Set(selected.map((part) => part.category)).size !==
      Object.keys(labels).length
  )
    throw Error('整机必须包含数据库中八类完整且不重复的商品');
  const validation = { status: 'not_applicable' as const, issues: [] };
  const result = recommendDetailed(r, parts, pcs);
  const reference = result.plans[0]?.budget;
  if (!reference) throw Error(result.failure?.reason ?? '无法确认预算边界');
  const references = {
    minimum: reference.minimumReference,
    high: reference.highReference,
  };
  if (
    !withinBudget(pc.price, r.budget, r.hardCap, references, r.budgetTolerance)
  )
    throw Error('该整机售价不符合预算规则');
  return {
    id: pc.id,
    kind: 'prebuilt',
    name: pc.name,
    parts: selected,
    total: pc.price,
    validation,
    score: 0,
    reason:
      '模型查询并选择数据库整机，服务端已核对最新整机售价、八类构成及用户约束；商家整机不执行DIY配件兼容性审核。',
    budget: assessBudget(pc.price, r, references, reference.highReferenceBasis),
  };
}
export function assembleBuild(
  ids: string[],
  r: Requirements,
  catalog: Part[],
): Plan {
  if (r.mode === 'prebuilt')
    throw Error('整机模式只能选择数据库中的现有整机；修改配件请先切换为 DIY');
  if (
    ids.length !== Object.keys(labels).length ||
    new Set(ids).size !== ids.length
  )
    throw Error('必须提交八类且不重复的商品 ID');
  const ps = ids.map((id) => catalog.find((p) => p.id === id));
  if (ps.some((p): p is undefined => !p)) throw Error('指定商品不存在');
  const parts = ps as Part[],
    categories = new Set(parts.map((p) => p.category));
  if (
    categories.size !== Object.keys(labels).length ||
    Object.keys(labels).some((c) => !categories.has(c as Category))
  )
    throw Error('配置类别不完整或存在重复类别');
  for (const p of parts) {
    const selected = r.partPreferences?.[p.category];
    if (selected && selected !== p.id)
      throw Error(`${labels[p.category]}未使用用户指定型号`);
    const brand = r.brandPreferences?.[p.category];
    if (brand && !p.brand.toLowerCase().includes(brand.toLowerCase()))
      throw Error(`${labels[p.category]}不符合品牌偏好`);
  }
  for (const p of parts)
    if (!matchesSeries(p.name, r.seriesPreferences?.[p.category]))
      throw Error(`${labels[p.category]}不符合指定系列`);
  const wrongColors = parts.filter(
    (part) => !matchesRequirementColor(part, r, catalog),
  );
  if (wrongColors.length)
    throw Error(
      wrongColors
        .map(
          (part) =>
            `${labels[part.category]}颜色不符合${requiredPartColor(part, r)}要求`,
        )
        .join('；'),
    );
  const total = calculateQuote(
    parts.map((p) => p.id),
    catalog,
  );
  const validation = validateBuild(parts);
  if (validation.status === 'fail') throw Error(validation.issues.join('；'));
  const referenceResult = findDiyBudgetReferences(r, catalog);
  if (
    referenceResult.minimum === undefined ||
    referenceResult.high === undefined
  )
    throw Error(
      referenceResult.kind === 'missing_products'
        ? '当前约束缺少完整八类商品'
        : referenceResult.kind === 'known_conflict'
          ? '当前约束下商品存在已知兼容冲突'
          : '搜索达到计算上限，无法确认最低或最高完整配置',
    );
  const references = {
    minimum: referenceResult.minimum,
    high: referenceResult.high,
  };
  if (!withinBudget(total, r.budget, r.hardCap, references, r.budgetTolerance))
    throw Error('自主搭配总价不符合预算规则');
  return {
    id: `assembled-${parts.map((p) => p.id).join('-')}`,
    kind: 'diy',
    name: '自主搭配方案',
    parts,
    total,
    score: 0,
    validation,
    reason: `模型选择具体型号，服务端已从数据库重新读取八类商品并计算总价。价格为商家目录价；${validation.status === 'unknown' ? '存在待确认项。' : '已录入规格未发现冲突。'}`,
    budget: assessBudget(total, r, references, referenceResult.highBasis!),
  };
}
export function replacePart(
  plan: Plan,
  oldId: string,
  newId: string,
  r: Requirements,
  catalog: Part[],
): Plan {
  if (plan.kind !== 'diy') throw Error('整机请重新筛选，不能自由替换配件');
  const freshParts = plan.parts.map((part) =>
    catalog.find((item) => item.id === part.id),
  );
  if (freshParts.some((part) => !part))
    throw Error('原方案商品已从数据库移除，请重新生成方案');
  const old = (freshParts as Part[]).find((p) => p.id === oldId),
    next = catalog.find((p) => p.id === newId);
  if (!old || !next || old.category !== next.category)
    throw Error('替换商品不存在或类别不一致');
  const ids = (freshParts as Part[]).map((part) =>
    part.id === oldId ? newId : part.id,
  );
  const verified = assembleBuild(ids, r, catalog);
  return {
    ...verified,
    id: plan.id,
    name: '已调整的 DIY 方案',
  };
}
