import {
  labels,
  type Part,
  type Category,
  type Plan,
  type Prebuilt,
  type Requirements,
} from '../domain/types';
import { budgetRange, withinBudget } from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import { calculateQuote, searchPrebuiltCatalog } from './catalog-search';
const weights: Record<string, number[]> = {
  游戏: [0.19, 0.4, 0.075, 0.09, 0.065, 0.055, 0.075, 0.05],
  办公: [0.23, 0.17, 0.12, 0.12, 0.08, 0.08, 0.14, 0.06],
  编程: [0.25, 0.18, 0.16, 0.1, 0.065, 0.065, 0.12, 0.06],
  剪辑设计: [0.23, 0.3, 0.12, 0.09, 0.06, 0.05, 0.1, 0.05],
  '本地 AI': [0.14, 0.46, 0.12, 0.08, 0.06, 0.04, 0.06, 0.04],
};
function matchesSeries(name: string, series?: string) {
  if (!series) return true;
  const normalized = name.toUpperCase().replace(/\s+/g, ' '),
    wanted = series.toUpperCase().replace(/\s+/g, ' ');
  if (!normalized.includes(wanted)) return false;
  return !/^RTX 5070$/.test(wanted) || !/RTX 5070\s*TI/.test(normalized);
}
export function recommend(
  r: Requirements,
  parts: Part[],
  pcs: Prebuilt[],
): Plan[] {
  const range = budgetRange(r.budget, r.hardCap),
    cats = Object.keys(labels),
    w = weights[r.purpose] || weights.游戏;
  const score = (ps: Part[], total: number) =>
    ps.reduce((s, p) => {
      const target = r.budget * w[cats.indexOf(p.category)];
      return s + Math.abs(p.price - target) / Math.max(1, target);
    }, 0) +
    (Math.abs(total - r.budget) / r.budget) * 4;
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
    score: score(ps, total),
    validation: validateBuild(ps),
    reason: `按${r.purpose}用途匹配；${r.color === '不限' ? '颜色不限' : r.color + '机箱'}。${kind === 'prebuilt' ? '整机售价含 150 元装机服务，配件行展示商家目录价，不代表拆件成交价。' : '总价为八类配件价格之和，不含可选代装与显示器。'} 价格为商家统一目录价；待确认项请在装机前核实。`,
  });
  const results: Plan[] = [];
  if (r.mode !== 'prebuilt') {
    // 有界束搜索避免八类 SKU 笛卡尔积爆炸；先按已知平台约束剪枝，再按用途预算偏差排序。
    // 这是目录内启发式排序而非性能实测，截断到 600 个状态意味着不承诺数学最优解。
    let states: { ps: Part[]; total: number; cost: number }[] = [
      { ps: [], total: 0, cost: 0 },
    ];
    for (let ci = 0; ci < cats.length; ci++) {
      const category = cats[ci];
      const candidates = parts.filter(
        (p) =>
          p.category === category &&
          (!r.partPreferences?.[category as Category] ||
            p.id === r.partPreferences[category as Category]) &&
          matchesSeries(p.name, r.seriesPreferences?.[category as Category]) &&
          (!r.brandPreferences?.[category as Category] ||
            p.brand
              .toLowerCase()
              .includes(
                r.brandPreferences[category as Category]!.toLowerCase(),
              )) &&
          (category !== 'case' || r.color === '不限' || p.color === r.color),
      );
      const next: typeof states = [];
      for (const s of states)
        for (const p of candidates) {
          const total = s.total + p.price;
          if (total > range.max) continue;
          const selected = Object.fromEntries(s.ps.map((p) => [p.category, p]));
          if (
            category === 'motherboard' &&
            (selected.cpu?.specs.socket !== p.specs.socket ||
              selected.memory?.specs.ddr !== p.specs.ddr)
          )
            continue;
          if (category === 'memory' && selected.cpu?.specs.ddr !== p.specs.ddr)
            continue;
          const target = r.budget * w[ci];
          next.push({
            ps: [...s.ps, p],
            total,
            cost: s.cost + Math.abs(p.price - target) / Math.max(1, target),
          });
        }
      // Retain representatives in price buckets as well as the best allocations to avoid spending all beam space on near-duplicates.
      next.sort((a, b) => a.cost - b.cost);
      const buckets = new Map<number, number>();
      states = next
        .filter((s) => {
          const key = Math.floor(s.total / 100);
          const n = buckets.get(key) || 0;
          buckets.set(key, n + 1);
          return n < 12;
        })
        .slice(0, 600);
    }
    const valid = states
      .filter(
        (s) =>
          withinBudget(s.total, r.budget, r.hardCap) &&
          validateBuild(s.ps).status !== 'fail',
      )
      .map((s, i) => make(s.ps, 'diy', `diy-${i}`, '自由搭配方案', s.total))
      .sort((a, b) =>
        r.preferCheaper ? a.total - b.total : a.score - b.score,
      );
    const first = valid[0];
    if (first) {
      first.name = '用途均衡方案';
      results.push(first);
      const alternate = [...valid]
        .sort((a, b) => a.total - b.total)
        .find(
          (p) =>
            p.total < first.total - 100 &&
            p.parts.filter((x, i) => x.id !== first.parts[i].id).length >= 2,
        );
      if (alternate) {
        alternate.name = '预算节省方案';
        results.push(alternate);
      }
    }
  }
  if (r.mode !== 'diy')
    for (const pc of searchPrebuiltCatalog(pcs, r)) {
      if (!withinBudget(pc.price, r.budget, r.hardCap)) continue;
      const ps = pc.partIds
        .map((id) => parts.find((p) => p.id === id))
        .filter((x): x is Part => !!x);
      if (
        ps.length !== pc.partIds.length ||
        ps.some((p) => {
          const id = r.partPreferences?.[p.category];
          return !!id && p.id !== id;
        }) ||
        ps.some(
          (p) => !matchesSeries(p.name, r.seriesPreferences?.[p.category]),
        ) ||
        ps.some((p) => {
          const brand = r.brandPreferences?.[p.category];
          return (
            !!brand && !p.brand.toLowerCase().includes(brand.toLowerCase())
          );
        }) ||
        validateBuild(ps).status === 'fail'
      )
        continue;
      results.push(make(ps, 'prebuilt', pc.id, pc.name, pc.price));
    }
  const diy = results
    .filter((x) => x.kind === 'diy')
    .sort((a, b) => (r.preferCheaper ? a.total - b.total : a.score - b.score))
    .slice(0, r.mode === 'both' ? 2 : 3);
  const pre = results
    .filter((x) => x.kind === 'prebuilt')
    .sort((a, b) => (r.preferCheaper ? a.total - b.total : a.score - b.score))
    .slice(0, r.mode === 'both' ? 1 : 3);
  const selected = [...diy, ...pre].filter((p) =>
    withinBudget(p.total, r.budget, r.hardCap),
  );
  return r.preferCheaper
    ? selected.sort((a, b) => a.total - b.total)
    : selected;
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
  if (
    r.color !== '不限' &&
    parts.find((p) => p.category === 'case')?.color !== r.color
  )
    throw Error('机箱颜色不符合用户要求');
  const total = calculateQuote(
    parts.map((p) => p.id),
    catalog,
  );
  if (!withinBudget(total, r.budget, r.hardCap))
    throw Error('自主搭配总价不符合预算规则');
  const validation = validateBuild(parts);
  if (validation.status === 'fail') throw Error(validation.issues.join('；'));
  return {
    id: `assembled-${parts.map((p) => p.id).join('-')}`,
    kind: 'diy',
    name: '自主搭配方案',
    parts,
    total,
    score: 0,
    validation,
    reason: `模型选择具体型号，服务端已从数据库重新读取八类商品并计算总价。价格为商家目录价；${validation.status === 'unknown' ? '存在待确认项。' : '已录入规格未发现冲突。'}`,
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
  const old = plan.parts.find((p) => p.id === oldId),
    next = catalog.find((p) => p.id === newId);
  if (!old || !next || old.category !== next.category)
    throw Error('替换商品不存在或类别不一致');
  const ps = plan.parts.map((p) => (p.id === oldId ? next : p));
  const total = calculateQuote(
      ps.map((p) => p.id),
      catalog,
    ),
    validation = validateBuild(ps);
  if (!withinBudget(total, r.budget, r.hardCap))
    throw Error('替换后超出允许预算区间');
  if (validation.status === 'fail') throw Error(validation.issues.join('；'));
  if (
    r.color !== '不限' &&
    ps.find((p) => p.category === 'case')?.color !== r.color
  )
    throw Error('替换后不符合机箱颜色要求');
  const preferredBrand = r.brandPreferences?.[next.category];
  if (
    preferredBrand &&
    !next.brand.toLowerCase().includes(preferredBrand.toLowerCase())
  )
    throw Error(`替换后不符合${labels[next.category]}品牌偏好`);
  return {
    ...plan,
    parts: ps,
    total,
    validation,
    name: '已调整的 DIY 方案',
  };
}
