import { createHmac, randomBytes } from 'node:crypto';
import { labels, type Part, type Requirements } from '../domain/types';
import type {
  RequirementAcceptance,
  RequirementCheck,
} from '../domain/requirement-acceptance';
import { budgetRange, type BudgetReferences } from '../rules/budget';
import {
  matchesRequirementColor,
  requiredPartColor,
  isColorCategory,
} from '../rules/color';
import { matchesModel, matchesExclusions } from './catalog-search';
import { ToolExecutionError } from '../domain/errors';
import {
  judgeRequirements,
  type RequirementJudgeOptions,
} from '../agent/jev-requirements';

// 进程内验收凭证；不使用外部密钥，不允许模型伪造通过。刷新后的会话不恢复。
const signingKey = randomBytes(32);
const sign = (value: unknown) =>
  createHmac('sha256', signingKey).update(JSON.stringify(value)).digest('hex');
export function candidateVersion(
  parts: Part[],
  requirements: Requirements,
  total: number,
  catalog: Part[],
) {
  const {
    partSelections: _selections,
    selectionSources: _sources,
    selectionConfirmationMessageIds: _confirmations,
    ...effective
  } = requirements;
  return sign({ parts, total, effective, catalog });
}
export function trustedAcceptance(
  receipt: RequirementAcceptance | undefined,
  version: string,
) {
  if (
    !receipt?.signature ||
    receipt.candidateVersion !== version ||
    !receipt.passed
  )
    return false;
  const { signature, ...unsigned } = receipt;
  return signature === sign(unsigned);
}
export function inspectRequirements(
  parts: Part[],
  r: Requirements,
  total: number,
  catalog: Part[],
  references?: BudgetReferences,
): RequirementAcceptance {
  const checks: RequirementCheck[] = [];
  const add = (
    id: string,
    text: string,
    expected: unknown,
    actual: unknown,
    status: RequirementCheck['status'],
    evidence: unknown[] = [],
    strength: 'hard' | 'soft' = 'hard',
    missing: string[] = [],
  ) => {
    const field = id.replace('builtin:', '').split(':')[0]!;
    const originFields =
      field === 'budget'
        ? ['budget', 'hardCap', 'budgetTolerance']
        : field === 'exclusions'
          ? ['excludedModels', 'excludedBrands']
          : field === 'color'
            ? ['color', 'partColors', 'excludedColors']
            : [field];
    const original = id.startsWith('builtin:')
      ? [
          ...new Set(
            originFields
              .map((key) => r.requirementOrigins?.[key]?.text)
              .filter(Boolean),
          ),
        ].join('；')
      : '';
    checks.push({
      requirementId: id,
      text: original || text,
      strength,
      status,
      expected,
      actual,
      evidence,
      missingInformation: missing,
    });
  };
  const range = budgetRange(r.budget, r.hardCap, references, r.budgetTolerance);
  add(
    'builtin:budget',
    references && r.budget > references.high
      ? `只能交付目录最高参考 ¥${references.high}`
      : '总价满足当前预算规则',
    range,
    total,
    Number.isFinite(total)
      ? total >= range.min && total <= range.max
        ? 'pass'
        : 'fail'
      : 'unknown',
    parts.map((p) => ({ id: p.id, price: p.price })),
  );
  for (const category of Object.keys(labels) as (keyof typeof labels)[]) {
    const selected = parts.filter((part) => part.category === category);
    const part = selected[0];
    add(
      `builtin:complete:${category}`,
      `${labels[category]}完整性`,
      '一个真实商品',
      selected.map((p) => p.id),
      selected.length === 1 ? 'pass' : 'fail',
    );
    const known = part
      ? [{ id: part.id, brand: part.brand, name: part.name, color: part.color }]
      : [];
    for (const [field, value, actual, satisfied] of [
      [
        'partPreferences',
        r.partPreferences?.[category],
        part?.id,
        part?.id === r.partPreferences?.[category],
      ],
      [
        'seriesPreferences',
        r.seriesPreferences?.[category],
        part?.name,
        !!part &&
          matchesModel(part.name, r.seriesPreferences?.[category], category),
      ],
      [
        'brandPreferences',
        r.brandPreferences?.[category],
        part?.brand,
        !!part &&
          part.brand
            .toLowerCase()
            .includes((r.brandPreferences?.[category] ?? '').toLowerCase()),
      ],
    ] as const) {
      if (value)
        add(
          `builtin:${field}:${category}`,
          `${labels[category]}${field === 'seriesPreferences' ? '不符合指定系列' : field === 'brandPreferences' ? '品牌偏好' : '指定型号'}`,
          value,
          actual ?? null,
          !part || !actual ? 'unknown' : satisfied ? 'pass' : 'fail',
          known,
        );
    }
    if (
      r.excludedModels?.[category]?.length ||
      r.excludedBrands?.[category]?.length
    )
      add(
        `builtin:exclusions:${category}`,
        `${labels[category]}排除的型号或品牌`,
        {
          models: r.excludedModels?.[category] ?? [],
          brands: r.excludedBrands?.[category] ?? [],
        },
        known,
        !part ? 'unknown' : matchesExclusions(part, r) ? 'pass' : 'fail',
        known,
      );
    if (
      !part &&
      isColorCategory(category) &&
      ((r.partColors?.[category] || r.color) !== '不限' ||
        r.excludedColors?.length)
    )
      add(
        `builtin:color:${category}`,
        `${labels[category]}颜色要求`,
        {
          color: r.partColors?.[category] || r.color,
          excluded: r.excludedColors ?? [],
        },
        null,
        'unknown',
        [],
        'hard',
        ['缺少对应商品的颜色资料'],
      );
    if (
      part &&
      isColorCategory(category) &&
      (requiredPartColor(part, r) !== '不限' || r.excludedColors?.length)
    )
      add(
        `builtin:color:${category}`,
        `${labels[category]}颜色要求`,
        {
          color: requiredPartColor(part, r) ?? '不限',
          excluded: r.excludedColors ?? [],
        },
        part.color,
        !part.color
          ? 'unknown'
          : matchesRequirementColor(part, r, catalog)
            ? 'pass'
            : 'fail',
        known,
      );
  }
  for (const item of r.requirementItems ?? []) {
    if (!item.active) continue;
    const part = parts.find((p) => p.category === item.category);
    const inferred = part?.specs.inferredFields;
    const provenance = part?.specs.provenance;
    const fieldProvenance =
      provenance && typeof provenance === 'object'
        ? (provenance as Record<string, unknown>)[item.field]
        : undefined;
    const uncertain =
      (Array.isArray(inferred) && inferred.includes(item.field)) ||
      (typeof fieldProvenance === 'string' &&
        /inferred|推定/.test(fieldProvenance)) ||
      (!!fieldProvenance &&
        typeof fieldProvenance === 'object' &&
        (fieldProvenance as Record<string, unknown>).status === 'inferred');
    let actual =
      item.rule === 'preserve'
        ? part?.id
        : item.field === 'brand'
          ? part?.brand
          : item.field === 'model'
            ? part?.name
            : part?.specs[item.field];
    if (item.field === 'coolingType' && typeof actual === 'string') {
      const aliases: Record<string, string> = {
        air: '风冷',
        liquid: '水冷',
        aio: '水冷',
        风冷: '风冷',
        水冷: '水冷',
      };
      actual = aliases[actual.trim().toLowerCase()];
    }
    let status: RequirementCheck['status'] = 'unknown';
    if (
      part &&
      actual !== undefined &&
      actual !== null &&
      actual !== '' &&
      !uncertain
    ) {
      if (item.rule === 'min' || item.rule === 'max') {
        if (
          typeof actual === 'number' &&
          Number.isFinite(actual) &&
          typeof item.expected === 'number'
        )
          status = (
            item.rule === 'min'
              ? actual >= item.expected
              : actual <= item.expected
          )
            ? 'pass'
            : 'fail';
      } else if (item.rule !== 'semantic') {
        const equal =
          typeof actual === 'string' && typeof item.expected === 'string'
            ? actual.trim().toLowerCase() === item.expected.trim().toLowerCase()
            : actual === item.expected;
        status = (item.rule === 'not_equals' ? !equal : equal)
          ? 'pass'
          : 'fail';
      }
    }
    add(
      item.id,
      item.text,
      item.expected,
      actual ?? null,
      status,
      part &&
        actual !== undefined &&
        actual !== null &&
        actual !== '' &&
        !uncertain
        ? [{ productId: part.id, field: item.field, value: actual }]
        : [],
      item.strength,
      status === 'unknown'
        ? [
            item.rule === 'semantic' &&
            actual !== undefined &&
            actual !== null &&
            actual !== '' &&
            !uncertain
              ? '需要语义验收'
              : `缺少可信商品字段 ${item.category}.${item.field}`,
          ]
        : [],
    );
  }
  return {
    stage: 'requirements',
    passed: checks.every((c) => c.strength === 'soft' || c.status === 'pass'),
    candidateVersion: candidateVersion(parts, r, total, catalog),
    checks,
  };
}
export function rejectRequirements(
  report: RequirementAcceptance,
  r: Requirements,
): never {
  const issues = report.checks.filter(
    (check) => check.strength === 'hard' && check.status !== 'pass',
  );
  throw new ToolExecutionError(
    '需求验收未通过：' +
      issues
        .map(
          (c) => `${c.text}：${c.status === 'unknown' ? '无法确认' : '不满足'}`,
        )
        .join('；'),
    {
      code: 'requirement_acceptance_failed',
      ...report,
      issues: issues.map((item) => ({
        ...item,
        action:
          item.status === 'unknown'
            ? '补查可信资料或复核，不得据此认定零件不合格并自动换件'
            : '在授权范围内修改对应配置',
      })),
      preserveConstraints: r,
      retryable: true,
      guidance:
        '不得放宽预算、删除硬约束或更换未获授权的部件；所有修改后重新验收。无法完成则保留原方案并报告具体冲突。',
    },
  );
}
export function assertRequirements(
  parts: Part[],
  r: Requirements,
  total: number,
  catalog: Part[],
  references?: BudgetReferences,
  receipt?: RequirementAcceptance,
) {
  const version = candidateVersion(parts, r, total, catalog);
  const report = inspectRequirements(parts, r, total, catalog, references);
  if (trustedAcceptance(receipt, version)) {
    for (const check of report.checks) {
      if (
        r.requirementItems?.some(
          (item) => item.id === check.requirementId && item.rule === 'semantic',
        )
      ) {
        const prior = receipt!.checks.find(
          (item) => item.requirementId === check.requirementId,
        );
        if (prior) Object.assign(check, prior);
      }
    }
    report.passed = report.checks.every(
      (check) => check.strength === 'soft' || check.status === 'pass',
    );
  }
  if (!report.passed) rejectRequirements(report, r);
  return { ...report, signature: sign(report) };
}
export async function acceptRequirements(
  parts: Part[],
  r: Requirements,
  total: number,
  catalog: Part[],
  references?: BudgetReferences,
  options: RequirementJudgeOptions = {},
  receipt?: RequirementAcceptance,
) {
  const version = candidateVersion(parts, r, total, catalog);
  if (trustedAcceptance(receipt, version))
    return assertRequirements(parts, r, total, catalog, references, receipt);
  const report = inspectRequirements(parts, r, total, catalog, references);
  // 明确的规则失败/缺资料先返回，不用语义判断覆盖，不浪费外部调用。
  const semanticIds = new Set(
    (r.requirementItems ?? [])
      .filter((item) => item.active && item.rule === 'semantic')
      .map((item) => item.id),
  );
  if (
    !report.checks.some(
      (check) =>
        check.strength === 'hard' &&
        check.status !== 'pass' &&
        (!semanticIds.has(check.requirementId) || !check.evidence.length),
    )
  ) {
    const pending = report.checks.filter(
      (check) => semanticIds.has(check.requirementId) && check.evidence.length,
    );
    const judged = await judgeRequirements(pending, options);
    for (const check of pending) {
      check.status = judged[check.requirementId] ?? 'unknown';
      check.missingInformation =
        check.status === 'unknown'
          ? ['语义判断缺失、低置信度或服务不可用，需要复核']
          : [];
    }
  }
  report.passed = report.checks.every(
    (check) => check.strength === 'soft' || check.status === 'pass',
  );
  if (!report.passed) rejectRequirements(report, r);
  return { ...report, signature: sign(report) };
}
