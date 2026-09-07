export const BUDGET_TOLERANCE = 1000;
// 软预算允许正负 1000 元；hardCap 将上界收紧到预算本身，但不会取消下界。
// 所有推荐、组装和替换都调用这里，避免各入口产生不同的预算语义。
export function budgetRange(budget: number, hardCap = false) {
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > 1_000_000 ||
    Math.abs(Math.round(budget * 100) - budget * 100) > 0.000001
  )
    throw new Error(
      '请输入大于 0、不超过 1,000,000 元且最多两位小数的有效预算',
    );
  return {
    min: Math.max(0, budget - BUDGET_TOLERANCE),
    max: hardCap ? budget : budget + BUDGET_TOLERANCE,
  };
}
export function withinBudget(total: number, budget: number, hardCap = false) {
  const { min, max } = budgetRange(budget, hardCap);
  return Number.isFinite(total) && total >= min && total <= max;
}
