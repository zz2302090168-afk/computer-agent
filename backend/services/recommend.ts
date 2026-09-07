import {
  labels,
  type Part,
  type Plan,
  type Prebuilt,
  type Requirements,
} from '../domain/types';
import { budgetRange, withinBudget } from '../rules/budget';
import { validateBuild } from '../rules/compatibility';
import { calculate_quote, estimate_fps, search_prebuilt_pcs } from '../tools';
const weights: Record<string, number[]> = {
  游戏: [0.19, 0.4, 0.075, 0.09, 0.065, 0.055, 0.075, 0.05],
  办公: [0.23, 0.17, 0.12, 0.12, 0.08, 0.08, 0.14, 0.06],
  编程: [0.25, 0.18, 0.16, 0.1, 0.065, 0.065, 0.12, 0.06],
  剪辑设计: [0.23, 0.3, 0.12, 0.09, 0.06, 0.05, 0.1, 0.05],
  '本地 AI': [0.14, 0.46, 0.12, 0.08, 0.06, 0.04, 0.06, 0.04],
};
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
    reason: `按${r.purpose}用途匹配；${r.color === '不限' ? '颜色不限' : r.color + '机箱'}。${kind === 'prebuilt' ? '整机售价含演示装机服务，配件行价格仅为目录参考价。' : '总价为八类配件价格之和，不含可选代装与显示器。'} 演示性能等级只用于流程验证。`,
    fps: estimate_fps(ps, r.game),
  });
  const results: Plan[] = [];
  if (r.mode !== 'prebuilt') {
    // Bounded beam search across independent SKU choices. Compatibility pruning happens before ranking.
    let states: { ps: Part[]; total: number; cost: number }[] = [
      { ps: [], total: 0, cost: 0 },
    ];
    for (let ci = 0; ci < cats.length; ci++) {
      const category = cats[ci];
      const candidates = parts.filter(
        (p) =>
          p.category === category &&
          (!r.brand || p.brand.includes(r.brand)) &&
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
          validateBuild(s.ps).status === 'pass',
      )
      .map((s, i) => make(s.ps, 'diy', `diy-${i}`, '自由搭配方案', s.total))
      .sort((a, b) => a.score - b.score);
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
    for (const pc of search_prebuilt_pcs(pcs, r)) {
      if (!withinBudget(pc.price, r.budget, r.hardCap)) continue;
      const ps = pc.partIds
        .map((id) => parts.find((p) => p.id === id))
        .filter((x): x is Part => !!x);
      if (
        ps.length !== pc.partIds.length ||
        validateBuild(ps).status !== 'pass'
      )
        continue;
      results.push(make(ps, 'prebuilt', pc.id, pc.name, pc.price));
    }
  const diy = results
    .filter((x) => x.kind === 'diy')
    .sort((a, b) => a.score - b.score)
    .slice(0, r.mode === 'both' ? 2 : 3);
  const pre = results
    .filter((x) => x.kind === 'prebuilt')
    .sort((a, b) => a.score - b.score)
    .slice(0, r.mode === 'both' ? 1 : 3);
  return [...diy, ...pre].filter((p) =>
    withinBudget(p.total, r.budget, r.hardCap),
  );
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
  const total = calculate_quote(
      ps.map((p) => p.id),
      catalog,
    ),
    validation = validateBuild(ps);
  if (!withinBudget(total, r.budget, r.hardCap))
    throw Error('替换后超出允许预算区间');
  if (validation.status !== 'pass') throw Error(validation.issues.join('；'));
  if (
    r.color !== '不限' &&
    ps.find((p) => p.category === 'case')?.color !== r.color
  )
    throw Error('替换后不符合机箱颜色要求');
  return {
    ...plan,
    parts: ps,
    total,
    validation,
    fps: estimate_fps(ps, r.game),
    name: '已调整的 DIY 方案',
  };
}
