import { labels, type Part, type Validation } from '../domain/types';
import { createHash } from 'node:crypto';

// 绑定完整配置及规格；报价不影响散热核验，规格/配件变化则旧证据失效。
export function thermalEvidenceKey(parts: Part[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        parts
          .map((part) => {
            const { thermalAssessments: _assessments, ...specs } = part.specs;
            return { id: part.id, specs };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest('hex');
}
export function validateBuild(parts: Part[], partial = false): Validation {
  const issues: string[] = [],
    unknown: string[] = [];
  const p = Object.fromEntries(parts.map((x) => [x.category, x]));
  for (const c of Object.keys(labels)) {
    if (!partial && !p[c])
      issues.push(`缺少 ${labels[c as keyof typeof labels]}`);
    if (parts.filter((x) => x.category === c).length > 1)
      issues.push(`${c} 重复`);
  }
  if (issues.length) return { status: 'fail', issues };
  // 搜索中的局部组合复用同一套规则；缺失配件的规格按未知处理。
  const cpu = p.cpu?.specs ?? {},
    board = p.motherboard?.specs ?? {},
    ram = p.memory?.specs ?? {},
    gpu = p.gpu?.specs ?? {},
    psu = p.psu?.specs ?? {},
    box = p.case?.specs ?? {},
    cooler = p.cooler?.specs ?? {},
    ssd = p.storage?.specs ?? {};
  // false 是已知冲突，必须阻止有效推荐；undefined 是厂家资料不足，只能标为待确认。
  const isInferred = (part: Part | undefined, field: string) => {
    const inferredFields = part?.specs.inferredFields;
    if (Array.isArray(inferredFields) && inferredFields.includes(field))
      return true;
    const provenance = part?.specs.provenance;
    if (!provenance || typeof provenance !== 'object') return false;
    const entry = (provenance as Record<string, unknown>)[field];
    return (
      !!entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).origin === 'synthetic' &&
      (entry as Record<string, unknown>).status === 'inferred'
    );
  };
  const check = (
    condition: boolean | undefined,
    text: string,
    inferredBy: [Part | undefined, string][] = [],
  ) => {
    const inferred = inferredBy.some(([part, field]) =>
      isInferred(part, field),
    );
    if (condition === undefined) {
      unknown.push(
        `${text.replace(/不匹配|不足|过长|过高|超过主板上限|空间冲突/g, '核对')}：资料不足，待确认`,
      );
    } else if (!condition) {
      issues.push(
        inferred ? `${text}（基于推定值初筛，待厂家规格确认）` : text,
      );
    } else if (inferred) {
      unknown.push(
        `${text.replace(/不匹配|不足|过长|过高|超过主板上限|空间冲突/g, '核对')}：推定值初筛通过，待厂家规格确认`,
      );
    }
  };
  const eq = (a: unknown, b: unknown) =>
    a === undefined || b === undefined ? undefined : a === b;
  const le = (a: unknown, b: unknown) =>
    typeof a !== 'number' || typeof b !== 'number' ? undefined : a <= b;
  const includes = (a: unknown, b: unknown) =>
    !Array.isArray(a) || b === undefined ? undefined : a.includes(b);
  check(eq(cpu.socket, board.socket), 'CPU 与主板插槽不匹配');
  check(eq(ram.ddr, board.ddr), '内存与主板代际不匹配');
  check(eq(ram.ddr, cpu.ddr), '内存与 CPU 平台不匹配');
  check(includes(board.supportedCpus, p.cpu?.id), '主板 CPU 支持列表不匹配', [
    [p.motherboard, 'supportedCpus'],
  ]);
  if (board.biosVerified !== true || isInferred(p.motherboard, 'biosVerified'))
    unknown.push('出厂 BIOS 支持待确认');
  check(le(ram.capacity, board.maxRam), '内存容量超过主板上限', [
    [p.motherboard, 'maxRam'],
  ]);
  check(le(ram.sticks, board.ramSlots), '内存插槽不足');
  check(includes(box.forms, board.form), '主板板型与机箱不匹配');
  check(le(gpu.length, box.gpuLength), '显卡过长');
  check(le(gpu.thickness, box.gpuThickness), '显卡厚度空间检查', [
    [p.case, 'gpuThickness'],
  ]);
  check(includes(cooler.sockets, cpu.socket), '散热扣具不匹配');
  check(le(cooler.height, box.coolerHeight), '散热器过高');
  check(le(ram.height, cooler.ramClearance), '内存与散热器空间冲突', [
    [p.memory, 'height'],
    [p.cooler, 'ramClearance'],
  ]);
  const thermal = Array.isArray(box.thermalAssessments)
    ? (box.thermalAssessments.find((entry: unknown) => {
        if (!entry || typeof entry !== 'object') return false;
        const item = entry as Record<string, unknown>;
        return (
          item.configurationKey === thermalEvidenceKey(parts) &&
          typeof item.source === 'string' &&
          item.source.trim() &&
          item.verified === true
        );
      }) as Record<string, unknown> | undefined)
    : undefined;
  if (thermal?.status === 'fail') issues.push('完整配置的散热与风道核验未通过');
  else if (
    thermal?.status !== 'pass' ||
    isInferred(p.case, 'thermalAssessments')
  )
    unknown.push('散热满载能力与风道待确认；CPU TDP 不等于实际整机功耗');
  check(le(gpu.recommendedPsu, psu.watts), '电源未满足显卡厂家建议功率');
  if (gpu.connector !== 'none') {
    const counts = psu.connectorCounts as Record<string, number> | undefined;
    check(
      le(gpu.connectors, counts?.[String(gpu.connector)]),
      '显卡供电接口及数量检查',
      [[p.psu, 'connectorCounts']],
    );
  }
  check(eq(psu.form, box.psuForm), '电源规格不匹配');
  check(le(psu.length, box.psuLength), '电源过长');
  check(
    ssd.interface === undefined || board.m2 === undefined
      ? undefined
      : ssd.interface === 'M.2 NVMe' && board.m2 === true,
    '硬盘接口支持待核对',
  );
  return {
    status: issues.length ? 'fail' : unknown.length ? 'unknown' : 'pass',
    // 局部检查只报告已知冲突，避免把尚未提交的其他配件列成大量缺失规格。
    issues: partial ? issues : [...issues, ...unknown],
  };
}
