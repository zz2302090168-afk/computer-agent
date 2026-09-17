import { labels, type Part, type Prebuilt } from '../domain/types';

const specLabels: Record<string, string> = {
  socket: '插槽',
  ddr: '内存代际',
  capacity: '容量（GB）',
  sticks: '条数',
  frequency: '频率（MHz）',
  speed: '速率（目录记录）',
  height: '高度（mm）',
  length: '长度（mm）',
  thickness: '厚度（mm）',
  watts: '额定功率（W）',
  power: '功耗（W）',
  recommendedPsu: '建议电源功率（W）',
  connector: '供电接口',
  connectors: '接口数量',
  form: '规格尺寸类型',
  interface: '接口类型',
  ramClearance: '内存避让空间（mm）',
};

export function catalogPartReply(part: Part) {
  const inferred = Array.isArray(part.specs.inferredFields)
    ? part.specs.inferredFields
    : [];
  const specs = Object.entries(specLabels).flatMap(([key, label]) => {
    const value = part.specs[key];
    if (typeof value !== 'string' && typeof value !== 'number') return [];
    const provenance = part.specs.provenance;
    const record =
      provenance && typeof provenance === 'object' && key in provenance
        ? Reflect.get(provenance, key)
        : undefined;
    const uncertain =
      inferred.includes(key) ||
      record?.status === 'inferred' ||
      record?.manufacturerVerified === false;
    return [`${label}：${value}${uncertain ? '（推定或未核实，待确认）' : ''}`];
  });
  return [
    `${labels[part.category]}：${part.brand} ${part.name}，目录价¥${part.price}${part.demo ? '（演示商品，型号与报价仅供演示）' : ''}。`,
    !['cpu', 'storage'].includes(part.category) ? `配色：${part.color}。` : '',
    specs.length ? `目录记录：${specs.join('；')}。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function catalogPageReply(parts: Part[], nextOffset: number | null) {
  return [
    ...parts.map(catalogPartReply),
    !parts.length
      ? '当前查询条件下，本页未找到匹配商品；不能据此断言整个目录或该品牌没有其他商品。'
      : '',
    nextOffset !== null ? '以上仅为当前页，后面还有目录记录。' : '',
    '以上仅依据当前目录记录；未返回的信息不能确认，也未据此完成配置预算或兼容性审核。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function catalogPrebuiltPageReply(
  pcs: Prebuilt[],
  parts: Part[],
  nextOffset: number | null,
) {
  return [
    ...pcs.map((pc) =>
      [
        `${pc.brand} ${pc.name}，整机目录价¥${pc.price}${pc.demo ? '（演示商品，型号与报价仅供演示）' : ''}。`,
        ...pc.partIds.map((id) => {
          const part = parts.find((p) => p.id === id);
          return part
            ? `${labels[part.category]}：${part.brand} ${part.name}${part.demo ? '（演示商品）' : ''}${!['cpu', 'storage'].includes(part.category) ? `，${part.color}` : ''}。`
            : '有构成商品未在当前目录中查到，需核对。';
        }),
      ].join('\n'),
    ),
    !pcs.length ? '当前查询条件下，本页未找到匹配整机。' : '',
    nextOffset !== null ? '以上仅为当前页，后面还有目录记录。' : '',
    '这里只介绍当前目录资料，未选定或确认，也未执行DIY配件兼容性审核；资料未提供的信息不能确认。',
    '[查看全部组装整机](/catalog?kind=prebuilt)',
  ]
    .filter(Boolean)
    .join('\n\n');
}
