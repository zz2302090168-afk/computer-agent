export const BUDGET_TOLERANCE = 1000;
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
