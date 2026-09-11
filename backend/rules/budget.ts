export const BUDGET_TOLERANCE = 1000;
const PLAN_PRICE_STEP = 500;
export function recommendationTargets(
  budget: number,
  hardCap = false,
  tolerance?: number,
) {
  const range = budgetRange(budget, hardCap, undefined, tolerance);
  const step = Math.min(PLAN_PRICE_STEP, (range.max - range.min) / 2);
  const center = Math.max(range.min + step, Math.min(budget, range.max - step));
  return [center - step, center, center + step];
}
export function validateTolerance(value: unknown = BUDGET_TOLERANCE) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > BUDGET_TOLERANCE ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.000001
  )
    throw Error('预算误差必须为0到1000元，最多两位小数');
  return value;
}
export type BudgetReferences = { minimum: number; high: number };
export function assertBudget(budget: number) {
  if (
    !Number.isFinite(budget) ||
    budget <= 0 ||
    budget > 1_000_000 ||
    Math.abs(Math.round(budget * 100) - budget * 100) > 0.000001
  )
    throw new Error(
      '请输入大于 0、不超过 1,000,000 元且最多两位小数的有效预算',
    );
}
export function budgetRange(
  budget: number,
  hardCap = false,
  references?: BudgetReferences,
  tolerance?: number,
) {
  assertBudget(budget);
  const deviation = validateTolerance(tolerance);
  if (references && budget < references.minimum)
    return {
      min: references.minimum,
      max: references.minimum,
      reference: true,
    };
  if (references && budget > references.high)
    return {
      min: 0,
      max: budget,
      reference: true,
    };
  return {
    min: Math.max(0, budget - deviation),
    max: hardCap ? budget : budget + deviation,
    reference: false,
  };
}
export function withinBudget(
  total: number,
  budget: number,
  hardCap = false,
  references?: BudgetReferences,
  tolerance?: number,
) {
  const { min, max } = budgetRange(budget, hardCap, references, tolerance);
  return Number.isFinite(total) && total >= min && total <= max;
}
export function budgetStatus(budget: number, references: BudgetReferences) {
  assertBudget(budget);
  return budget < references.minimum
    ? ('below_minimum_reference' as const)
    : budget > references.high
      ? ('above_high_reference' as const)
      : ('standard' as const);
}
