import { labels, type Part, type Validation } from '../domain/types';
export function validateBuild(parts: Part[]): Validation {
  const issues: string[] = [],
    unknown: string[] = [];
  const p = Object.fromEntries(parts.map((x) => [x.category, x]));
  for (const c of Object.keys(labels)) {
    if (!p[c]) issues.push(`缺少 ${labels[c as keyof typeof labels]}`);
    if (parts.filter((x) => x.category === c).length > 1)
      issues.push(`${c} 重复`);
  }
  if (issues.length) return { status: 'fail', issues };
  const cpu = p.cpu.specs,
    board = p.motherboard.specs,
    ram = p.memory.specs,
    gpu = p.gpu.specs,
    psu = p.psu.specs,
    box = p.case.specs,
    cooler = p.cooler.specs,
    ssd = p.storage.specs;
  const check = (condition: boolean | undefined, text: string) =>
    condition === undefined
      ? unknown.push(`${text}：资料不足`)
      : !condition && issues.push(text);
  const eq = (a: unknown, b: unknown) =>
    a === undefined || b === undefined ? undefined : a === b;
  const le = (a: unknown, b: unknown) =>
    typeof a !== 'number' || typeof b !== 'number' ? undefined : a <= b;
  const includes = (a: unknown, b: unknown) =>
    !Array.isArray(a) || b === undefined ? undefined : a.includes(b);
  check(eq(cpu.socket, board.socket), 'CPU 与主板插槽不匹配');
  check(eq(ram.ddr, board.ddr), '内存与主板代际不匹配');
  check(eq(ram.ddr, cpu.ddr), '内存与 CPU 平台不匹配');
  check(includes(board.supportedCpus, p.cpu.id), '主板 CPU 支持列表不匹配');
  if (board.biosVerified !== true) unknown.push('出厂 BIOS 支持待确认');
  check(le(ram.capacity, board.maxRam), '内存容量超过主板上限');
  check(le(ram.sticks, board.ramSlots), '内存插槽不足');
  check(includes(box.forms, board.form), '主板板型与机箱不匹配');
  check(le(gpu.length, box.gpuLength), '显卡过长');
  check(le(gpu.slots, box.gpuSlots), '显卡厚度超过机箱空间');
  check(includes(cooler.sockets, cpu.socket), '散热扣具不匹配');
  check(le(cooler.height, box.coolerHeight), '散热器过高');
  check(le(ram.height, cooler.ramClearance), '内存与散热器空间冲突');
  check(le(cpu.power, cooler.capacity), '散热能力不足');
  const recommended =
    typeof cpu.power === 'number' && typeof gpu.power === 'number'
      ? Math.ceil((cpu.power + gpu.power + 80) * 1.3)
      : undefined;
  check(le(recommended, psu.watts), '电源功率不足');
  check(eq(gpu.connector, psu.connector), '显卡供电接口不匹配');
  check(le(gpu.connectors, psu.connectors), '显卡供电接口数量不足');
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
    issues: [...issues, ...unknown],
  };
}
