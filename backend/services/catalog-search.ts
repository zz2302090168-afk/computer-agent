import type { Category, Part, Prebuilt, Requirements } from '../domain/types';

export type CatalogSearch = {
  category?: Category;
  brand?: string;
  modelKeyword?: string;
  color?: string;
  minPrice?: number;
  maxPrice?: number;
};

// 芯片型号按完整词匹配，5060 不包含 5060 Ti，9600X 不包含其他后缀。
export function matchesModel(name: string, keyword: string) {
  const compact = keyword.trim().replace(/\s+/g, ' ');
  const gpu = compact.match(
    /^(?:geforce\s+)?(?:rtx\s*)?(\d{4})(?:\s*(ti|super|ti super))?$/i,
  );
  if (gpu) {
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
  const cpu = compact.match(/^(?:ryzen\s+[579]\s+)?(\d{4}[a-z0-9]*)$/i);
  if (cpu)
    return name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .includes(cpu[1].toLowerCase());
  return name.toLowerCase().includes(compact.toLowerCase());
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
      (!keyword || matchesModel(`${p.brand} ${p.name}`, keyword)) &&
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
