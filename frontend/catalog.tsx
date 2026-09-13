'use client';
import Link from 'next/link';
import { readResponse } from './api';
import type {
  Catalog,
  Monitor,
  MonitorCatalog,
  Prebuilt,
} from '@/backend/domain/types';
import PrebuiltCatalog from './prebuilt-catalog';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { labels, type Part } from '@/backend/domain/types';
const specLabels: Record<string, string> = {
  socket: '处理器插槽',
  sockets: '支持插槽',
  ddr: '内存类型',
  tdp: '热设计功耗',
  power: '功耗',
  recommendedPsu: '建议电源功率',
  length: '长度',
  thickness: '厚度',
  height: '高度',
  connector: '供电接口',
  connectors: '供电接口数量',
  connectorCounts: '供电接口配置',
  capacity: '容量',
  sticks: '内存条数',
  ramSlots: '内存插槽数',
  form: '规格尺寸',
  forms: '支持主板规格',
  m2: '支持 M.2',
  biosVerified: 'BIOS 兼容性已核实',
  watts: '额定功率',
  coolerHeight: '散热器限高',
  psuForm: '支持电源规格',
  psuLength: '电源限长',
  gpuLength: '显卡限长',
  gpuLengthNote: '显卡安装说明',
  interface: '接口类型',
  checkedAt: '资料核对日期',
  priceBasis: '价格依据',
  source: '资料来源',
  maxRam: '最大内存容量',
  gpuThickness: '显卡限厚',
  ramClearance: '内存避让高度',
  supportedCpus: '支持处理器',
  resolution: '分辨率',
  panel: '面板类型',
  refreshRate: '刷新率',
  refreshRateNote: '刷新率说明',
  size: '屏幕尺寸',
};
function specValue(
  key: string,
  value: unknown,
  category?: Part['category'],
): string {
  if (value === null || value === undefined || value === '') return '未提供';
  if (typeof value === 'boolean')
    return key === 'biosVerified'
      ? value
        ? '已核实'
        : '待核实'
      : value
        ? '支持'
        : '不支持';
  if (Array.isArray(value))
    return (
      value.map((item) => specValue(key, item, category)).join('、') || '未提供'
    );
  if (typeof value === 'object')
    return Object.entries(value)
      .map(
        ([name, count]) =>
          `${specLabels[name] ?? name}：${specValue(name, count, category)}`,
      )
      .join('；');
  if (value === 'merchant-authored') return '商家自定目录价';
  if (key === 'connector' && value === 'none') return '无需外接供电';
  if (typeof value === 'number') {
    if (key === 'refreshRate') return `${value} Hz`;
    if (key === 'size') return `${value} 英寸`;
    if (['tdp', 'power', 'recommendedPsu', 'watts'].includes(key))
      return `${value} W`;
    if (
      [
        'length',
        'thickness',
        'height',
        'coolerHeight',
        'psuLength',
        'gpuLength',
        'gpuThickness',
        'ramClearance',
      ].includes(key)
    )
      return `${value} mm`;
    if (key === 'maxRam' || (key === 'capacity' && category === 'memory'))
      return `${value} GB`;
    if (key === 'sticks') return `${value} 条`;
    if (['ramSlots', 'connectors'].includes(key)) return `${value} 个`;
  }
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '未提供';
}
export default function Catalog({
  kind = 'prebuilt',
}: {
  kind?: 'prebuilt' | 'part' | 'monitor';
}) {
  const [parts, setParts] = useState<Part[]>([]),
    [prebuilts, setPrebuilts] = useState<Prebuilt[]>([]),
    [monitors, setMonitors] = useState<Monitor[]>([]),
    [filter, setFilter] = useState('cpu'),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [monitorLoading, setMonitorLoading] = useState(true),
    [monitorError, setMonitorError] = useState('');
  useEffect(() => {
    fetch('/api/catalog')
      .then(async (r) => {
        const d = await readResponse<Catalog>(r);
        setParts(d.parts);
        setPrebuilts(d.prebuilts);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    fetch('/api/monitors')
      .then(async (r) => {
        const d = await readResponse<MonitorCatalog>(r);
        setMonitors(d.monitors);
      })
      .catch((e) => setMonitorError(e.message))
      .finally(() => setMonitorLoading(false));
  }, []);
  const showingMonitors = kind === 'monitor';
  const displayedLoading = showingMonitors ? monitorLoading : loading;
  const displayedError = showingMonitors ? monitorError : error;
  const products: Array<Part | Monitor> = showingMonitors
    ? monitors
    : parts.filter((p) => p.category === filter);
  const visibleProducts = products.filter((p) =>
    `${p.name} ${p.brand} ${'color' in p ? p.color : ''}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <>
      <header>
        <Link className="brand" href="/">
          ← 装机研究所
        </Link>
        <span>商家商品目录</span>
      </header>
      <main className="catalog-page">
        <h1>商品目录</h1>
        <p className="hint">
          {loading
            ? '商品目录读取中'
            : error
              ? '商品目录暂不可用'
              : `${prebuilts.length} 台组装整机 · ${parts.length} 个配件`}
          {monitorLoading
            ? ' · 显示器读取中'
            : monitorError
              ? ' · 显示器暂不可用'
              : ` · ${monitors.length} 款显示器`}
          <br />
          价格为商家目录价，演示商品单独标注。可直接浏览，再回到对话咨询。
        </p>
        <nav className="catalog-sections" aria-label="目录分类">
          {(
            [
              ['prebuilt', '组装整机'],
              ['part', 'DIY 配件'],
              ['monitor', '显示器'],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={`/catalog?kind=${key}`}
              aria-current={kind === key ? 'page' : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        {kind === 'prebuilt' ? (
          <PrebuiltCatalog
            catalog={{ parts, prebuilts }}
            loading={loading}
            error={error}
          />
        ) : (
          <>
            <div className="catalog-toolbar">
              {!showingMonitors && (
                <div className="chips" aria-label="配件类别">
                  {Object.entries(labels).map(([k, v]) => (
                    <Button
                      key={k}
                      variant="outline"
                      className={filter === k ? 'active' : ''}
                      aria-pressed={filter === k}
                      onClick={() => setFilter(k)}
                    >
                      {v}
                    </Button>
                  ))}
                </div>
              )}
              <div className="catalog-search">
                <label htmlFor="catalog-query">搜索商品</label>
                <Input
                  id="catalog-query"
                  aria-label="搜索商品型号品牌"
                  placeholder={
                    showingMonitors ? '搜索型号、品牌' : '搜索型号、品牌、颜色'
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span aria-live="polite">
                  {displayedLoading
                    ? '正在读取商品…'
                    : displayedError
                      ? '商品读取失败'
                      : `${visibleProducts.length} 个匹配商品`}
                </span>
                {query && (
                  <Button variant="ghost" onClick={() => setQuery('')}>
                    清空搜索
                  </Button>
                )}
              </div>
            </div>
            {displayedError && (
              <p role="alert" className="error">
                {displayedError}
              </p>
            )}
            <section
              className="brief"
              aria-busy={displayedLoading}
              aria-label="商品列表"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>型号 / 品牌</TableHead>
                    <TableHead>
                      {showingMonitors ? '屏幕参数' : '颜色'}
                    </TableHead>
                    <TableHead>价格</TableHead>
                    <TableHead>规格</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(displayedLoading || !visibleProducts.length) && (
                    <TableRow>
                      <TableCell colSpan={4} className="catalog-state">
                        {displayedLoading
                          ? '正在加载商品与规格…'
                          : displayedError
                            ? '商品暂时无法加载，请刷新页面重试。'
                            : '没有匹配的商品，请调整关键词或切换类别。'}
                      </TableCell>
                    </TableRow>
                  )}
                  {visibleProducts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <b>{p.name}</b>
                        <br />
                        <span className="hint">
                          {p.brand} · {p.demo ? '演示商品' : '真实型号'}
                        </span>
                      </TableCell>
                      <TableCell>
                        {'color' in p ? (
                          p.color
                        ) : (
                          <>
                            {p.specs.size} 英寸 · {p.specs.resolution}
                            <br />
                            {p.specs.panel} · {p.specs.refreshRate} Hz
                            {p.specs.refreshRateNote && (
                              <div className="hint">
                                {p.specs.refreshRateNote}
                              </div>
                            )}
                            {!(p.specs.source && p.specs.checkedAt) && (
                              <div className="hint">规格待核实</div>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell>¥{p.price.toLocaleString()}</TableCell>
                      <TableCell>
                        <details>
                          <summary>查看规格</summary>
                          <dl className="mt-3 grid min-w-56 max-w-sm grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 whitespace-normal text-sm">
                            {Object.entries(p.specs).map(([key, value]) => (
                              <div key={key} className="contents">
                                <dt className="text-slate-500">
                                  {specLabels[key] ?? key}
                                </dt>
                                <dd className="m-0 break-words text-slate-800">
                                  {key === 'source' &&
                                  typeof value === 'string' &&
                                  /^https?:\/\//i.test(value) ? (
                                    <a
                                      href={value}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-sky-700 underline underline-offset-4"
                                    >
                                      查看原始资料 ↗
                                    </a>
                                  ) : (
                                    specValue(
                                      key,
                                      value,
                                      'category' in p ? p.category : undefined,
                                    )
                                  )}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          </>
        )}
      </main>
    </>
  );
}
