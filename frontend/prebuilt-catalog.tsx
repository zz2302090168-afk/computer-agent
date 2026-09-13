'use client';

import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { labels, type Catalog, type Category } from '../backend/domain/types';
import {
  filterPrebuilts,
  indexPrebuilts,
  type PrebuiltCatalogItem,
} from './prebuilt-catalog-data';
import styles from './prebuilt-catalog.module.css';

const categoryLabels = { ...labels, gpu: '显卡' };
const colorCategories = [
  'gpu',
  'memory',
  'motherboard',
  'psu',
  'case',
  'cooler',
] as const;
const summaryCategories = ['cpu', 'gpu', 'memory', 'storage'] as const;
const initialFilters = {
  query: '',
  brand: '',
  color: '',
  minPrice: '',
  maxPrice: '',
  sort: 'catalog',
};
const PAGE_SIZE = 12;

function PrebuiltCard({ item }: { item: PrebuiltCatalogItem }) {
  const { product, parts, missingPartIds, demo } = item;
  const categoryParts = (category: Category) =>
    parts.filter((part) => part.category === category);
  const names = (category: Category) =>
    categoryParts(category)
      .map((part) => part.name)
      .join('、') || '配件记录缺失';
  const incomplete =
    missingPartIds.length > 0 ||
    Object.keys(categoryLabels).some(
      (category) => categoryParts(category as Category).length !== 1,
    );
  return (
    <article className={styles.card}>
      <div className={styles.meta}>
        <span>{product.brand || '品牌未提供'}</span>
        <span className={demo ? styles.demo : styles.identity}>
          {demo ? '演示商品' : '真实型号'}
        </span>
      </div>
      <h3>{product.name}</h3>
      <div className={styles.priceRow}>
        <strong>¥{product.price.toLocaleString('zh-CN')}</strong>
        <span>整机售价</span>
      </div>
      <dl className={styles.specs}>
        {summaryCategories.map((category) => (
          <div key={category}>
            <dt>{categoryLabels[category]}</dt>
            <dd>{names(category)}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.colors}>
        <p>整机标注：{product.color || '颜色未提供'}</p>
        <dl>
          {colorCategories.map((category) => (
            <div key={category}>
              <dt>{categoryLabels[category]}</dt>
              <dd>
                {categoryParts(category)
                  .map((part) => part.color || '未提供')
                  .join(' / ') || '缺失'}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {incomplete && (
        <p className={styles.notice}>配件记录需补齐或核对，展开查看详情。</p>
      )}
      <details className={styles.details}>
        <summary>查看八类完整配置</summary>
        <dl className={styles.specs}>
          {Object.entries(categoryLabels).map(([category, label]) => (
            <div key={category}>
              <dt>{label}</dt>
              <dd>{names(category as Category)}</dd>
            </div>
          ))}
        </dl>
        {missingPartIds.length > 0 && (
          <p className={styles.notice}>
            有 {missingPartIds.length} 条配件记录缺失，请向商家核对完整配置。
          </p>
        )}
        <p className={styles.note}>
          商家组装整机按完整商品提供，以整机售价为准。
        </p>
      </details>
      <Link
        className={styles.consult}
        href={`/?prebuilt=${encodeURIComponent(product.id)}`}
        aria-label={`咨询这台：${product.name}`}
      >
        咨询这台 <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export default function PrebuiltCatalog({
  catalog,
  loading,
  error,
}: {
  catalog: Catalog;
  loading: boolean;
  error: string;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const [page, setPage] = useState(1);
  const rangeErrorId = useId();
  const items = useMemo(() => indexPrebuilts(catalog), [catalog]);
  const brands = [
    ...new Set(items.map(({ product }) => product.brand).filter(Boolean)),
  ];
  const colors = [
    ...new Set(items.map(({ product }) => product.color).filter(Boolean)),
  ];
  const minPrice =
    filters.minPrice === '' ? undefined : Number(filters.minPrice);
  const maxPrice =
    filters.maxPrice === '' ? undefined : Number(filters.maxPrice);
  const rangeError = [minPrice, maxPrice].some(
    (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
  )
    ? '请输入大于或等于 0 的价格。'
    : minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice
      ? '最低价不能高于最高价。'
      : '';
  const matches = rangeError
    ? []
    : filterPrebuilts(items, { ...filters, minPrice, maxPrice });
  const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = matches.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  function changeFilter(key: keyof typeof filters, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setPage(1);
  }
  function clearFilters() {
    setFilters(initialFilters);
    setPage(1);
  }
  return (
    <section
      className={styles.catalog}
      aria-label="组装整机目录"
      aria-busy={loading}
    >
      <div className={styles.intro}>
        <div>
          <h2>组装整机</h2>
          <p>浏览全部商家整机，按型号、配色和价格找到合适的配置。</p>
        </div>
        <span>整机售价 · 八类明细</span>
      </div>
      <fieldset className={styles.filters} disabled={loading || !!error}>
        <legend className={styles.visuallyHidden}>筛选组装整机</legend>
        <label className={styles.search}>
          <span>搜索整机</span>
          <input
            type="search"
            placeholder="整机名称、品牌、CPU 或显卡型号"
            value={filters.query}
            onChange={(event) => changeFilter('query', event.target.value)}
          />
        </label>
        <label>
          <span>品牌</span>
          <select
            value={filters.brand}
            onChange={(event) => changeFilter('brand', event.target.value)}
          >
            <option value="">全部品牌</option>
            {brands.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>整机标注颜色</span>
          <select
            value={filters.color}
            onChange={(event) => changeFilter('color', event.target.value)}
          >
            <option value="">全部颜色</option>
            {colors.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>最低价（元）</span>
          <input
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="不限"
            value={filters.minPrice}
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? rangeErrorId : undefined}
            onChange={(event) => changeFilter('minPrice', event.target.value)}
          />
        </label>
        <label>
          <span>最高价（元）</span>
          <input
            type="number"
            min="0"
            inputMode="decimal"
            placeholder="不限"
            value={filters.maxPrice}
            aria-invalid={!!rangeError}
            aria-describedby={rangeError ? rangeErrorId : undefined}
            onChange={(event) => changeFilter('maxPrice', event.target.value)}
          />
        </label>
        <label>
          <span>排序</span>
          <select
            value={filters.sort}
            onChange={(event) => changeFilter('sort', event.target.value)}
          >
            <option value="catalog">目录顺序</option>
            <option value="price-asc">价格从低到高</option>
            <option value="price-desc">价格从高到低</option>
          </select>
        </label>
      </fieldset>
      {rangeError && (
        <p id={rangeErrorId} className={styles.notice} role="alert">
          {rangeError}
        </p>
      )}
      <div className={styles.resultsBar}>
        <p aria-live="polite">
          {loading ? (
            '正在读取整机目录…'
          ) : error ? (
            '整机目录读取失败'
          ) : (
            <>
              找到 <strong>{matches.length}</strong> 台整机{' '}
              <span>· 全部 {items.length} 台</span>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={clearFilters}
          disabled={Object.keys(initialFilters).every(
            (key) =>
              filters[key as keyof typeof filters] ===
              initialFilters[key as keyof typeof filters],
          )}
        >
          清除筛选
        </button>
      </div>
      {error ? (
        <div className={styles.state} role="alert">
          <h3>暂时无法读取整机目录</h3>
          <p>{error}</p>
        </div>
      ) : loading ? (
        <output className={styles.state}>正在加载整机与配件明细…</output>
      ) : !matches.length ? (
        <div className={styles.state}>
          <h3>
            {items.length ? '没有符合条件的整机' : '目录暂未收录组装整机'}
          </h3>
          <p>
            {items.length
              ? '可以减少筛选条件，或尝试其他型号关键词。'
              : '已收录的配件和显示器仍可在其他类别浏览。'}
          </p>
        </div>
      ) : (
        <div className={styles.grid}>
          {visible.map((item) => (
            <PrebuiltCard key={item.product.id} item={item} />
          ))}
        </div>
      )}
      {!loading && !error && pageCount > 1 && (
        <nav className={styles.pagination} aria-label="整机目录分页">
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setPage(currentPage - 1)}
          >
            上一页
          </button>
          <span aria-live="polite">
            第 {currentPage} / {pageCount} 页
          </span>
          <button
            type="button"
            disabled={currentPage === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            下一页
          </button>
        </nav>
      )}
    </section>
  );
}
