'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { readResponse } from './api';
import type {
  Part,
  Plan,
  Catalog,
  RecommendationResult,
} from '@/backend/domain/types';
export default function Results({
  result,
  onChange,
}: {
  result: RecommendationResult;
  onChange: (r: RecommendationResult) => void;
}) {
  const [catalog, setCatalog] = useState<Part[]>([]),
    [edit, setEdit] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState('');
  async function begin(id: string) {
    setError('');
    try {
      if (!catalog.length) {
        const r = await fetch('/api/catalog');
        const data = await readResponse<Catalog>(r);
        setCatalog(data.parts);
      }
      setEdit(edit === id ? '' : id);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function replace(planId: string, oldId: string, newId: string) {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/replace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, oldId, newId }),
      });
      const data = await readResponse<RecommendationResult>(r);
      onChange({ ...result, ...data });
      setEdit('');
      setConfirmed('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function download(plan: Plan) {
    const blob = new Blob(
      [JSON.stringify({ requirements: result.requirements, plan }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = '电脑配置.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <>
      <p className="result-summary">{result.summary}</p>
      {result.explanation && (
        <p className="result-summary">{result.explanation}</p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result.plans?.map((plan: Plan) => (
        <article className="plan" key={plan.id}>
          <div className="plan-head">
            <div>
              <span className="eyebrow">
                {plan.kind === 'diy' ? 'DIY BUILD' : 'PREBUILT'}
              </span>
              <h3>{plan.name}</h3>
            </div>
            <strong>¥{plan.total.toLocaleString()}</strong>
          </div>
          <p className="hint">
            预算差额 {plan.total - result.requirements.budget >= 0 ? '+' : ''}¥
            {plan.total - result.requirements.budget} ·{' '}
            {plan.parts.some((p: Part) => p.demo)
              ? '演示规格校验通过'
              : '规格校验通过'}
          </p>
          <div className="parts">
            {plan.parts.map((p: Part) => (
              <div key={p.id}>
                <span>{p.categoryLabel}</span>
                <b>
                  {p.brand} {p.name}
                  <small>{p.color}</small>
                  {plan.kind === 'diy' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => begin(plan.id + p.id)}
                    >
                      替换
                    </Button>
                  )}
                  {edit === plan.id + p.id && (
                    <Select
                      disabled={busy}
                      value={p.id}
                      onValueChange={(v) => v && replace(plan.id, p.id, v)}
                    >
                      <SelectTrigger aria-label={`替换${p.categoryLabel}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catalog
                          .filter((x) => x.category === p.category)
                          .map((x) => (
                            <SelectItem key={x.id} value={x.id}>
                              {x.name} · {x.color} · ¥{x.price}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                </b>
                <span>¥{p.price}</span>
              </div>
            ))}
          </div>
          <p>{plan.reason}</p>
          <div className="fps-note">
            <b>游戏帧率</b>
            <p className="hint">{plan.fps.message}</p>
          </div>
          <div className="chips">
            <Button variant="outline" onClick={() => download(plan)}>
              导出配置
            </Button>
            <Button variant="outline" onClick={() => setConfirmed(plan.id)}>
              确认这套主机
            </Button>
          </div>
          {confirmed === plan.id && (
            <p className="hint">
              已选定这套主机。下一步可以根据用途和额外预算讨论显示器；当前演示型号没有实测性能，暂不据此承诺分辨率或刷新率。
            </p>
          )}
        </article>
      ))}
      {(result.evidence?.length ?? 0) > 0 && (
        <details className="sources">
          <summary>查看推荐依据与知识来源</summary>
          {result.evidence?.map((k) => (
            <div key={k.id}>
              <h4>{k.title}</h4>
              <p>{k.content}</p>
              {k.source ? (
                <a href={k.source} target="_blank" rel="noreferrer">
                  厂家原始资料 ↗
                </a>
              ) : (
                <span>项目推荐策略</span>
              )}
              <small> · 核对日期 {k.checkedAt}</small>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
