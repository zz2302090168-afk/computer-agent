'use client';
import Link from 'next/link';
import { readResponse } from './api';
import type { Catalog } from '@/backend/domain/types';
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
export default function Catalog() {
  const [parts, setParts] = useState<Part[]>([]),
    [filter, setFilter] = useState('cpu'),
    [query, setQuery] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/catalog')
      .then(async (r) => {
        const d = await readResponse<Catalog>(r);
        setParts(d.parts);
      })
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <header>
        <Link className="brand" href="/">
          ← 装机研究所
        </Link>
        <span>商家商品目录</span>
      </header>
      <main>
        <span className="eyebrow">MERCHANT CATALOG</span>
        <h1>每一个配件，都有据可查。</h1>
        <p className="hint">
          当前 160
          个演示配件，价格与规格均为流程演示。整机可在推荐页筛选。无库存数量和在售状态。
        </p>
        <div className="chips">
          {Object.entries(labels).map(([k, v]) => (
            <Button
              key={k}
              variant="outline"
              className={filter === k ? 'active' : ''}
              onClick={() => setFilter(k)}
            >
              {v}
            </Button>
          ))}
        </div>
        <Input
          className="my-5 max-w-md"
          aria-label="搜索商品型号品牌"
          placeholder="搜索型号、品牌、颜色"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <section className="brief">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>型号 / 品牌</TableHead>
                <TableHead>颜色</TableHead>
                <TableHead>价格</TableHead>
                <TableHead>规格</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {parts
                .filter(
                  (p) =>
                    p.category === filter &&
                    `${p.name}${p.brand}${p.color}`.includes(query),
                )
                .map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <b>{p.name}</b>
                      <br />
                      <span className="hint">{p.brand}</span>
                    </TableCell>
                    <TableCell>{p.color}</TableCell>
                    <TableCell>¥{p.price.toLocaleString()}</TableCell>
                    <TableCell>
                      <details>
                        <summary>查看规格</summary>
                        <pre className="text-xs whitespace-pre-wrap max-w-xs">
                          {JSON.stringify(p.specs, null, 2)}
                        </pre>
                      </details>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </section>
      </main>
    </>
  );
}
