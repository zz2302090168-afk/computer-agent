'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type {
  MonitorCriteria,
  MonitorPurpose,
  MonitorRecommendation as MonitorRecommendationResult,
  MonitorPanel,
  MonitorResolution,
} from '@/backend/domain/types';
import type { PlanActionResponse } from '@/backend/api/plan-actions';
import { readResponse } from './api';
import { pageSessionHeaders } from './workspace-session';

const resolutions: Array<{ value: MonitorResolution | 'any'; label: string }> =
  [
    { value: 'any', label: '分辨率不限' },
    { value: '1080p', label: '1080p' },
    { value: '1440p', label: '1440p' },
    { value: '4K', label: '4K' },
  ];
const panels: Array<{ value: MonitorPanel | 'any'; label: string }> = [
  { value: 'any', label: '面板不限' },
  { value: 'IPS', label: 'IPS' },
  { value: 'VA', label: 'VA' },
  { value: 'OLED', label: 'OLED' },
  { value: 'MiniLED', label: 'MiniLED' },
];
const purposes: Array<{ value: MonitorPurpose; label: string }> = [
  { value: '综合', label: '综合使用' },
  { value: '游戏', label: '游戏' },
  { value: '办公', label: '办公' },
  { value: '剪辑设计', label: '剪辑设计' },
];
const refreshRates = [60, 75, 144, 240, 300];

export default function MonitorRecommendation({
  taskId,
  taskVersion,
  hostReady,
  defaultPurpose,
  disabled,
  recommendation,
  onChange,
}: {
  taskId?: string;
  taskVersion?: number;
  hostReady: boolean;
  defaultPurpose?: string;
  disabled?: boolean;
  recommendation?: MonitorRecommendationResult;
  onChange: (result: PlanActionResponse) => void;
}) {
  const [budget, setBudget] = useState(
    String(recommendation?.criteria.budget ?? ''),
  );
  const [resolution, setResolution] = useState<MonitorResolution | 'any'>(
    recommendation?.criteria.resolution ?? 'any',
  );
  const [panel, setPanel] = useState<MonitorPanel | 'any'>(
    recommendation?.criteria.panel ?? 'any',
  );
  const [minRefreshRate, setMinRefreshRate] = useState(
    String(recommendation?.criteria.minRefreshRate ?? 60),
  );
  const [purpose, setPurpose] = useState<MonitorPurpose>(
    recommendation?.criteria.purpose ??
      (defaultPurpose === '游戏' ||
      defaultPurpose === '办公' ||
      defaultPurpose === '剪辑设计'
        ? defaultPurpose
        : '综合'),
  );
  const result = recommendation;
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const budgetInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);

  function changed() {
    setDirty(true);
    setError('');
  }

  function stepBudget(direction: 1 | -1) {
    const input = budgetInputRef.current;
    if (!input || disabled || loading) return;
    if (direction === 1) input.stepUp();
    else input.stepDown();
    changed();
    setBudget(input.value);
  }

  function stepRefreshRate(direction: 1 | -1) {
    if (disabled || loading) return;
    const current = Number(minRefreshRate);
    const next =
      direction === 1
        ? refreshRates.find((rate) => rate > current)
        : [...refreshRates].reverse().find((rate) => rate < current);
    if (next === undefined) return;
    changed();
    setMinRefreshRate(String(next));
  }

  async function submit() {
    if (!taskId || !taskVersion || !hostReady || disabled || loading) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const criteria: MonitorCriteria = { purpose };
      if (budget.trim()) criteria.budget = Number(budget);
      if (resolution !== 'any') criteria.resolution = resolution;
      if (panel !== 'any') criteria.panel = panel;
      if (minRefreshRate.trim())
        criteria.minRefreshRate = Number(minRefreshRate);
      const response = await fetch('/api/monitors', {
        method: 'POST',
        headers: {
          ...pageSessionHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId,
          expectedVersion: taskVersion,
          criteria,
        }),
        signal: controller.signal,
      });
      const data = await readResponse<PlanActionResponse>(response);
      if (controller.signal.aborted) return;
      setDirty(false);
      onChange(data);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : '显示器推荐失败');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <section
      className="monitor-recommendation"
      aria-labelledby="monitor-heading"
    >
      <div className="monitor-heading">
        <div>
          <span className="eyebrow">
            {hostReady
              ? '主机方案已生成，可继续筛选显示器'
              : '请先完成主机配置'}
          </span>
          <h3 id="monitor-heading">显示器推荐</h3>
        </div>
        <span className="monitor-count">
          {result ? `${result.catalogTotal} 个目录型号` : '数据库目录'}
        </span>
      </div>
      <p className="hint">
        显示器是独立外设，不计入这套主机报价。按用途和显示偏好筛选，不以未验证的游戏帧率作推荐依据。
      </p>
      <form
        className="monitor-form"
        noValidate
        aria-busy={loading}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="monitor-field">
          <label htmlFor="monitor-budget">显示器预算</label>
          <div className="relative">
            <Input
              id="monitor-budget"
              ref={budgetInputRef}
              className="monitor-budget-input pr-12"
              type="number"
              disabled={disabled || loading}
              inputMode="numeric"
              min={0}
              max={5000}
              step={500}
              placeholder="200–5000 元，可留空"
              value={budget}
              onChange={(event) => {
                changed();
                setBudget(event.target.value);
              }}
            />
            <div className="monitor-stepper-arrows absolute inset-y-1 right-1 grid w-9 grid-rows-2">
              <button
                className="rounded text-xs hover:bg-muted focus-visible:outline-2 disabled:opacity-30"
                type="button"
                aria-label="增加显示器预算"
                disabled={disabled || loading || Number(budget) >= 5000}
                onClick={() => stepBudget(1)}
              >
                ▲
              </button>
              <button
                className="rounded text-xs hover:bg-muted focus-visible:outline-2 disabled:opacity-30"
                type="button"
                aria-label="减少显示器预算"
                disabled={disabled || loading || Number(budget) <= 0}
                onClick={() => stepBudget(-1)}
              >
                ▼
              </button>
            </div>
          </div>
        </div>
        <div className="monitor-field">
          <span id="monitor-resolution-label">分辨率</span>
          <Select
            value={resolution}
            items={resolutions}
            disabled={disabled || loading}
            onValueChange={(value) => {
              changed();
              setResolution(value as MonitorResolution | 'any');
            }}
          >
            <SelectTrigger aria-labelledby="monitor-resolution-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {resolutions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="monitor-field">
          <span id="monitor-panel-label">面板</span>
          <Select
            value={panel}
            items={panels}
            disabled={disabled || loading}
            onValueChange={(value) => {
              changed();
              setPanel(value as MonitorPanel | 'any');
            }}
          >
            <SelectTrigger aria-labelledby="monitor-panel-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {panels.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="monitor-field">
          <span id="monitor-refresh-rate-label">最低刷新率</span>
          <div className="relative">
            <Input
              aria-labelledby="monitor-refresh-rate-label"
              className="pr-12"
              value={`${minRefreshRate} Hz`}
              readOnly
              disabled={disabled || loading}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  stepRefreshRate(event.key === 'ArrowUp' ? 1 : -1);
                }
              }}
            />
            <div className="monitor-stepper-arrows absolute inset-y-1 right-1 grid w-9 grid-rows-2">
              <button
                className="rounded text-xs hover:bg-muted focus-visible:outline-2 disabled:opacity-30"
                type="button"
                aria-label="提高最低刷新率"
                disabled={disabled || loading || Number(minRefreshRate) >= 300}
                onClick={() => stepRefreshRate(1)}
              >
                ▲
              </button>
              <button
                className="rounded text-xs hover:bg-muted focus-visible:outline-2 disabled:opacity-30"
                type="button"
                aria-label="降低最低刷新率"
                disabled={disabled || loading || Number(minRefreshRate) <= 60}
                onClick={() => stepRefreshRate(-1)}
              >
                ▼
              </button>
            </div>
          </div>
        </div>
        <div className="monitor-field">
          <span id="monitor-purpose-label">使用场景</span>
          <Select
            value={purpose}
            items={purposes}
            disabled={disabled || loading}
            onValueChange={(value) => {
              changed();
              setPurpose(value as MonitorPurpose);
            }}
          >
            <SelectTrigger aria-labelledby="monitor-purpose-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {purposes.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="submit"
          disabled={
            disabled || loading || !hostReady || !taskId || !taskVersion
          }
        >
          {loading ? '正在筛选…' : '推荐显示器'}
        </Button>
      </form>
      {dirty && result && (
        <p className="hint">筛选条件已变更，请重新推荐显示器。</p>
      )}
      {!hostReady && (
        <p className="monitor-blocked">
          请先生成一套完整主机方案，再开始显示器推荐。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result && !dirty && !error && !loading && (
        <div className="monitor-results" aria-live="polite">
          <p className="hint">{result.note}</p>
          {result.monitors.map((monitor) => (
            <article key={monitor.id} className="monitor-card">
              <div>
                <b>
                  {monitor.brand} {monitor.name}
                </b>
                <span>
                  {monitor.demo ? '演示型号' : '真实型号'} · 商家目录价
                </span>
              </div>
              <strong>¥{monitor.price.toLocaleString()}</strong>
              <div
                className="monitor-specs"
                aria-label={`${monitor.name} 主要规格`}
              >
                <span>{monitor.specs.size} 英寸</span>
                <span>{monitor.specs.resolution}</span>
                <span>{monitor.specs.panel}</span>
                <span>{monitor.specs.refreshRate}Hz</span>
                {monitor.specs.refreshRateNote && (
                  <span>{monitor.specs.refreshRateNote}</span>
                )}
                <span>
                  {monitor.specs.source && monitor.specs.checkedAt
                    ? '已附厂家规格来源'
                    : '规格待核实'}
                </span>
              </div>
              {monitor.specs.source?.startsWith('https://') && (
                <a href={monitor.specs.source} target="_blank" rel="noreferrer">
                  查看厂家规格
                </a>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
