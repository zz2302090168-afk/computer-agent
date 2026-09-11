import { labels, type Part } from '../domain/types';
import { validateBuild } from '../rules/compatibility';

type Build = { parts: Part[]; total: number };
type SearchOptions = {
  goal: 'minimum' | 'maximum' | 'budget';
  range?: { min: number; max: number };
  target?: number;
  priority?: (part: Part) => number;
  exclude?: Set<string>;
};
const SEARCH_LIMIT = 2_000_000;

// 三种搜索共用完整候选集和兼容规则；只有价格界与已知冲突可以剪枝。
export function createBuildSearch(groups: Part[][]) {
  const compatibility = new Map<Part, Map<Part, boolean>>();
  const compatible = (a: Part, b: Part) => {
    let row = compatibility.get(a);
    if (!row) {
      row = new Map();
      compatibility.set(a, row);
    }
    const cached = row.get(b);
    if (cached !== undefined) return cached;
    const valid = validateBuild([a, b], true).status !== 'fail';
    row.set(b, valid);
    return valid;
  };
  return ({ goal, range, target, priority, exclude }: SearchOptions) => {
    const solutions: Build[] = [];
    const budgetTarget = target ?? (range ? (range.min + range.max) / 2 : 0);
    let visits = 0;
    let limited = false;
    const domains = groups.map((group) =>
      [...group].sort((a, b) =>
        goal === 'maximum'
          ? b.price - a.price
          : goal === 'minimum'
            ? a.price - b.price
            : (priority?.(a) ?? 0) - (priority?.(b) ?? 0) || a.price - b.price,
      ),
    );
    const visit = (remaining: Part[][], selected: Part[], total: number) => {
      if (limited) return;
      if (++visits > SEARCH_LIMIT) {
        limited = true;
        return;
      }
      if (remaining.some((group) => !group.length)) return;
      let lower = total;
      let upper = total;
      for (const group of remaining) {
        let min = Infinity;
        let max = -Infinity;
        for (const part of group) {
          min = Math.min(min, part.price);
          max = Math.max(max, part.price);
        }
        lower += min;
        upper += max;
      }
      if (range && (lower > range.max || upper < range.min)) return;
      if (goal === 'budget' && solutions.length === 3) {
        const nearest = Math.max(lower - budgetTarget, budgetTarget - upper, 0);
        if (nearest >= Math.abs(solutions[2]!.total - budgetTarget)) return;
      }
      const best = solutions[0];
      if (best && goal === 'minimum' && lower >= best.total) return;
      if (best && goal === 'maximum' && upper <= best.total) return;
      if (!remaining.length) {
        if (validateBuild(selected).status === 'fail') return;
        if (
          exclude?.has(
            selected
              .map((part) => part.id)
              .sort()
              .join('|'),
          )
        )
          return;
        const parts = Object.keys(labels).map((category) =>
          selected.find((part) => part.category === category)!,
        );
        const build = { parts, total };
        if (goal === 'budget') {
          solutions.push(build);
          solutions.sort(
            (a, b) =>
              Math.abs(a.total - budgetTarget) -
              Math.abs(b.total - budgetTarget),
          );
          solutions.splice(3);
        } else solutions[0] = build;
        return;
      }
      // 优先处理候选最少的类别，选择后立即过滤其余类别的已知冲突。
      let index = 0;
      for (let i = 1; i < remaining.length; i++)
        if (remaining[i]!.length < remaining[index]!.length) index = i;
      const rest = remaining.filter((_, i) => i !== index);
      for (const part of remaining[index]!) {
        if (limited) break;
        const next = rest.map((group) =>
          group.filter((item) => compatible(part, item)),
        );
        visit(next, [...selected, part], total + part.price);
      }
    };
    visit(domains, [], 0);
    return { solutions, searchComplete: !limited };
  };
}
