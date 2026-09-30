import type { Category, Part, Prebuilt, Requirements } from '../domain/types';

export type CatalogSearch = {
  category?: Category;
  brand?: string;
  modelKeyword?: string;
  color?: string;
  minPrice?: number;
  maxPrice?: number;
};

// 配件按所属类别识别芯片型号，避免纯数字 CPU 型号被当成显卡。
export function matchesModel(
  name: string,
  keyword?: string,
  category?: Category,
) {
  if (!keyword) return true;
  const compact = keyword.trim().replace(/\s+/g, ' ');
  const gpu = compact.match(
    /^(?:geforce\s+)?(?:rtx\s*)?(\d{4})(?:\s*(ti|super|ti super))?$/i,
  );
  if (gpu && (category === 'gpu' || category === undefined)) {
    const model = name.match(
      /RTX[\s-]*(\d{4})(?:[\s-]+(Ti(?:[\s-]+SUPER)?|SUPER))?/i,
    );
    return (
      !!model &&
      model[1] === gpu[1] &&
      (model[2] ?? '').replace(/[\s-]+/g, ' ').toLowerCase() ===
        (gpu[2] ?? '').toLowerCase()
    );
  }
  const cpu = compact.match(
    /^(?:(?:amd\s+)?ryzen\s+[3579]\s+|(?:intel\s+)?(?:core\s+)?i[3579][\s-]*)?(\d{4,5}[a-z0-9]*)$/i,
  );
  if (cpu && (category === 'cpu' || category === undefined))
    return name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes(cpu[1].toLowerCase());
  return name
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .includes(compact.toLowerCase());
}

export function matchesExclusions(part: Part, requirements: Requirements) {
  return (
    !requirements.excludedModels?.[part.category]?.some((model) =>
      matchesModel(part.name, model, part.category),
    ) &&
    !requirements.excludedBrands?.[part.category]?.some((brand) =>
      part.brand.toLowerCase().includes(brand.toLowerCase()),
    )
  );
}

function matchesCatalogKeyword(part: Part, keyword: string) {
  if (
    matchesModel(`${part.brand} ${part.name}`, keyword, part.category) ||
    matchesModel(part.name, keyword, part.category)
  )
    return true;
  const query = keyword.trim().replace(/\s+/gu, ' ').toLowerCase();
  const brand = part.brand.trim().replace(/\s+/gu, ' ').toLowerCase();
  // 双语目录按中文/非中文整段区分名称，保留 Cooler Master 等英文词组，
  // 不把每个空格词猜成独立别名，也不引入芯片平台或外部品牌表。
  const aliases = (
    brand.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ?? []
  ).map((alias) => alias.trim());
  const prefixes = [...new Set([brand, ...aliases])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (!query.startsWith(`${prefix} `)) continue;
    const model = query.slice(prefix.length).trim();
    if (model && matchesModel(part.name, model, part.category)) return true;
  }
  return false;
}

export function searchCatalog(parts: Part[], filter: CatalogSearch) {
  const brand = filter.brand?.toLowerCase() ?? '',
    keyword = filter.modelKeyword?.toLowerCase() ?? '',
    min = filter.minPrice ?? 0,
    max = filter.maxPrice ?? Infinity;
  if (!Number.isFinite(min) || min < 0 || max < min)
    throw Error('价格区间无效');
  return parts.filter(
    (p) =>
      (!filter.category || p.category === filter.category) &&
      (!brand || p.brand.toLowerCase().includes(brand)) &&
      (!keyword || matchesCatalogKeyword(p, keyword)) &&
      (!filter.color ||
        filter.color === '不限' ||
        p.color.includes(filter.color)) &&
      p.price >= min &&
      p.price <= max,
  );
}

export function searchPrebuiltCatalog(
  pcs: Prebuilt[],
  requirements: Requirements,
) {
  return pcs.filter(
    (pc) => !requirements.brand || pc.brand.includes(requirements.brand),
  );
}

export function calculateQuote(ids: string[], catalog: Part[]) {
  if (new Set(ids).size !== ids.length) throw Error('商品重复');
  return ids.reduce((sum, id) => {
    const part = catalog.find((item) => item.id === id);
    if (!part || !Number.isFinite(part.price) || part.price < 0)
      throw Error('商品不存在或报价无效');
    return sum + part.price;
  }, 0);
}
