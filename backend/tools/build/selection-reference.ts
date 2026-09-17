import type { RecommendationResult } from '../../domain/types';
import { ToolExecutionError } from '../../domain/errors';

export function rejectSelectionReference(reason: string): never {
  throw new ToolExecutionError(reason, {
    code: 'selection_target_invalid',
    reason,
  });
}

function ordinalNumber(value: string) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let digit = 0;
  for (const char of value) {
    if (char === '十' || char === '百' || char === '千') {
      total += (digit || 1) * { 十: 10, 百: 100, 千: 1000 }[char];
      digit = 0;
    } else digit = digits[char];
  }
  return total + digit;
}

const ordinalPattern = String.raw`(?:第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*(?:套|个(?:方案)?|方案)|方案\s*([0-9零〇一二两三四五六七八九十百千]+))`;

function references(text: string) {
  const values = [...text.matchAll(new RegExp(ordinalPattern, 'gu'))].map(
    (match) => ordinalNumber(match[1] ?? match[2]),
  );
  return [...new Set(values)];
}

/** 仅核对已请求选定的对象，不从编号判断选定或确认授权。 */
export function assertSelectionReference(
  message: string,
  planId: string,
  result: RecommendationResult | null,
) {
  const excluded = new Set<number>();
  const remaining: number[] = [];
  // 只识别整个独立短分句的简单对象排除。含条件、双重否定或比较的
  // 编号分句不符合排除语法时保留引用；不解析全句条件作用域或授予选定权限。
  const exclusion = new RegExp(
    `^(?:不要|不要选|不要选择|不选|不选择)\\s*${ordinalPattern}$`,
    'u',
  );
  for (const clause of message.split(/[，,；;]/u)) {
    const negative = exclusion.exec(clause.trim());
    if (negative) excluded.add(ordinalNumber(negative[1] ?? negative[2]));
    else remaining.push(...references(clause));
  }
  const ordinals = [...new Set(remaining)];
  if (
    excluded.size &&
    (!ordinals.length || ordinals.some((n) => excluded.has(n)))
  )
    rejectSelectionReference(
      '选定对象缺失或与明确排除对象冲突，需要先明确要选择哪套方案。',
    );
  if (ordinals.length > 1)
    rejectSelectionReference(
      '当前消息包含多个方案编号，选定对象需要澄清；保留当前选择，不自行猜选',
    );
  if (ordinals.length === 1) {
    const plan = result?.plans[ordinals[0] - 1];
    if (!plan)
      rejectSelectionReference(
        `用户指定的第${ordinals[0]}套方案不存在；保留当前选择，不得改选其他方案或生成新方案`,
      );
    if (plan.id !== planId)
      rejectSelectionReference(
        `您指定的是第${ordinals[0]}套方案，本次选定对象与该编号不一致。`,
      );
  }
  const ids = (result?.plans ?? []).filter((plan) => {
    const escapedId = plan.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // DIY方案ID包含多个由|连接的商品ID；完整ID两侧不可紧邻ID字符，
    // 避免把较长ID中的前缀误认为用户引用了另一套方案。
    return new RegExp(
      `(?<![A-Za-z0-9_|.-])${escapedId}(?![A-Za-z0-9_|.-])`,
      'u',
    ).test(message);
  });
  if (ids.length > 1)
    rejectSelectionReference(
      '当前消息包含多个方案ID，选定对象需要澄清；保留当前选择',
    );
  if (ids.length === 1 && ids[0].id !== planId)
    rejectSelectionReference('本次选定对象与您明确指定的方案不一致。');
}
