import type { Catalog, Part, Prebuilt } from '../backend/domain/types';

export type PrebuiltCatalogItem = {
  product: Prebuilt;
  parts: Part[];
  missingPartIds: string[];
  demo: boolean;
};

export function indexPrebuilts(catalog: Catalog): PrebuiltCatalogItem[] {
  const partsById = new Map(catalog.parts.map((part) => [part.id, part]));
  return catalog.prebuilts.map((product) => {
    const parts = product.partIds.flatMap((id) => {
      const part = partsById.get(id);
      return part ? [part] : [];
    });
    return {
      product,
      parts,
      missingPartIds: product.partIds.filter((id) => !partsById.has(id)),
      demo: product.demo || parts.some((part) => part.demo),
    };
  });
}

export function filterPrebuilts(
  items: PrebuiltCatalogItem[],
  filters: {
    query: string;
    brand: string;
    color: string;
    minPrice?: number;
    maxPrice?: number;
    sort: string;
  },
) {
  const words = filters.query.trim().toLocaleLowerCase().split(/\s+/);
  const matches = items.filter(({ product, parts }) => {
    const searchable = [
      product.name,
      product.brand,
      ...parts
        .filter((part) => part.category === 'cpu' || part.category === 'gpu')
        .map((part) => `${part.brand} ${part.name}`),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return (
      words.every((word) => searchable.includes(word)) &&
      (!filters.brand || product.brand === filters.brand) &&
      (!filters.color || product.color === filters.color) &&
      (filters.minPrice === undefined || product.price >= filters.minPrice) &&
      (filters.maxPrice === undefined || product.price <= filters.maxPrice)
    );
  });
  if (filters.sort === 'price-asc')
    matches.sort((a, b) => a.product.price - b.product.price);
  if (filters.sort === 'price-desc')
    matches.sort((a, b) => b.product.price - a.product.price);
  return matches;
}
