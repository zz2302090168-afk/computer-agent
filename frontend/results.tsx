'use client';
import { useState } from 'react';
import { matchesRequirementColor } from '@/backend/rules/color';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { readResponse } from './api';
import { pageSessionHeaders } from './workspace-session';
import MonitorRecommendation from './monitor-recommendation';
import type { PlanActionResponse } from '@/backend/api/plan-actions';
import type {
  Part,
  Plan,
  RecommendationResult,
} from '@/backend/domain/types';
export default function Results({
  result,
  onChange,
  taskId,
  taskVersion,
  disabled = false,
}: {
  result: RecommendationResult;
  onChange: (r: PlanActionResponse) => void;
  taskId?: string;
  taskVersion?: number;
  disabled?: boolean;
}) {
  const [viewedPlan, setViewedPlan] = useState(''),
    [exporting, setExporting] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const confirmed =
    result.selection?.status === 'confirmed' ? result.selection.planId : '';
  const activePlan =
    result.plans.find((plan) => plan.id === viewedPlan)?.id ??
    result.plans.find((plan) => plan.id === result.selection?.planId)?.id ??
    result.plans[0]?.id;
  async function download(plan: Plan) {
    setExporting(plan.id);
    setError('');
    try {
      const response = await fetch('/api/export-docx', {
        method: 'POST',
        headers: {
          ...pageSessionHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          planId: plan.id,
          taskId,
          expectedVersion: taskVersion,
        }),
      });
      if (!response.ok) {
        const data = (await response.json()) as { error?: string };
        throw Error(data.error ?? 'Word 文件生成失败');
      }
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = '电脑配置方案.docx';
      a.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Word 文件生成失败');
    } finally {
      setExporting('');
    }
  }
  async function select(planId: string, confirm: boolean) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/confirm', {
        method: 'POST',
        headers: {
          ...pageSessionHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          planId,
          confirm,
          taskId,
          expectedVersion: taskVersion,
        }),
      });
      const data = await readResponse<PlanActionResponse>(response);
      onChange(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '交付审核失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="result-summary">{result.summary}</p>
      {result.explanation && (
        <p className="result-summary">{result.explanation}</p>
      )}
      {result.evaluation && (
        <section className="validation-note" aria-label="方案评估">
          <b>方案评估</b>
          {result.evaluation.directions.map((direction) => (
            <p key={direction}>{direction}</p>
          ))}
          {result.evaluation.suggestions.map((suggestion) => (
            <p key={suggestion.id}>
              {suggestion.summary}：
              {suggestion.valid ? '可以考虑' : `不可执行，${suggestion.reason}`}
            </p>
          ))}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!result.plans?.length && (
        <div className="configuration-empty">
          <h3>无匹配方案</h3>
          <p>
            {result.budgetDiagnostic?.reason ??
              '当前未找到匹配方案，请重新生成或检查条件。'}
          </p>
        </div>
      )}
      <Tabs
        value={activePlan ?? ''}
        onValueChange={(value) => {
          setViewedPlan(String(value));
          setError('');
        }}
        className="plan-tabs"
      >
        {result.plans.length > 1 && (
          <div className="plan-switcher-heading">
            <strong>{result.plans.length} 套候选方案</strong>
            <span>点击下方卡片切换方案</span>
          </div>
        )}
        {result.plans.length > 1 && (
          <TabsList aria-label="查看候选方案" className="plan-switcher">
            {result.plans.map((plan) => (
              <TabsTrigger value={plan.id} key={plan.id}>
                <span>{plan.tier ?? plan.name}</span>
                <strong>¥{plan.total.toLocaleString()}</strong>
                <small className="plan-budget-delta">
                  {plan.total === result.requirements.budget
                    ? '刚好符合预算'
                    : `${plan.total > result.requirements.budget ? '超出' : '节省'} ¥${Math.abs(plan.total - result.requirements.budget).toLocaleString()}`}
                </small>
                <small>
                  {activePlan === plan.id ? '当前查看' : '查看这套 →'}
                </small>
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        {result.plans?.map((plan: Plan) => (
          <TabsContent value={plan.id} key={plan.id}>
            <article className="plan">
              <div className="plan-head">
                <div>
                  <span className="eyebrow">
                    {plan.kind === 'diy'
                      ? '购买方式：DIY 自由搭配'
                      : '购买方式：商家组装整机'}
                  </span>
                  <h3>{plan.tier ?? plan.name}</h3>
                  {plan.demo && <small>包含演示商品，型号与报价仅供演示</small>}
                  {result.selection?.planId === plan.id && (
                    <small>
                      {confirmed === plan.id ? '已确认方案' : '当前选定方案'}
                    </small>
                  )}
                </div>
                <strong>¥{plan.total.toLocaleString()}</strong>
              </div>
              <div className="plan-facts">
                <div>
                  <span>与预算相比</span>
                  <strong>
                    {plan.total > result.requirements.budget
                      ? '超出 '
                      : plan.total < result.requirements.budget
                        ? '节省 '
                        : '刚好符合'}
                    {plan.total !== result.requirements.budget &&
                      `¥${Math.abs(plan.total - result.requirements.budget).toLocaleString()}`}
                  </strong>
                </div>
                <div>
                  <span>交付状态</span>
                  <strong>
                    {plan.parts.some(
                      (part) =>
                        !matchesRequirementColor(part, result.requirements),
                    )
                      ? '配色不符'
                      : plan.deliveryAudit?.status === 'passed'
                        ? plan.kind === 'prebuilt'
                          ? '整机记录已核验'
                          : '审核通过'
                        : plan.deliveryAudit?.status === 'reference'
                          ? '仅供参考'
                          : '尚未通过审核'}
                  </strong>
                </div>
              </div>
              <p className="hint">
                {plan.kind === 'prebuilt'
                  ? '商家整机不执行 DIY 配件兼容性审核'
                  : plan.validation.status === 'pass'
                    ? '已知兼容项目未发现冲突'
                    : '购买与装机前仍有兼容资料待核对'}
              </p>
              {plan.budget && <p className="hint">{plan.budget.reason}</p>}
              <div className="parts">
                {plan.parts.map((p: Part) => (
                  <div key={p.id}>
                    <span>{p.categoryLabel}</span>
                    <b>
                      {p.brand} {p.name}
                      <small>
                        {p.color} · {p.demo ? '演示商品' : '真实型号'} ·
                        商家目录价
                      </small>
                    </b>
                    <span>¥{p.price}</span>
                  </div>
                ))}
              </div>
              {plan.kind === 'prebuilt' && (
                <p className="hint">
                  整机售价：¥{plan.total.toLocaleString()}
                  。配件行显示商家目录价，仅用于说明配置构成，不作为拆件合计或成交价。
                </p>
              )}
              <p>{plan.reason}</p>
              {!!plan.validation.issues.length && (
                <details>
                  <summary>
                    购买与装机前待核对（{plan.validation.issues.length} 项）
                  </summary>
                  <p className="hint">
                    这些是需要补齐的具体型号资料。装好后的通电、硬件识别、稳定性和温度检查属于功能验收，不能替代这里的兼容性确认。
                  </p>
                  <ul>
                    {plan.validation.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="chips plan-secondary-actions">
                <Button
                  variant="outline"
                  disabled={busy || disabled || !!exporting}
                  onClick={() => download(plan)}
                >
                  {exporting === plan.id ? '正在生成…' : '导出 Word'}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy || disabled || result.selection?.planId === plan.id
                  }
                  onClick={() => select(plan.id, false)}
                >
                  设为当前方案
                </Button>
              </div>
              {confirmed === plan.id &&
                plan.deliveryAudit?.status === 'passed' &&
                plan.parts.every((part) =>
                  matchesRequirementColor(part, result.requirements),
                ) && (
                  <p className="hint">
                    已选定这套主机。下一步可以根据用途和额外预算讨论显示器；当前未匹配同配置实测性能，暂不据此承诺分辨率或刷新率。
                  </p>
                )}
              {plan.budget?.confirmable === false && (
                <p className="hint">
                  当前方案仅供参考。请先明确提高主机预算，再确认购买。
                </p>
              )}
            </article>
            <div className="plan-confirm-bar">
              <div>
                <small>
                  {plan.budget?.confirmable === false
                    ? '超预算参考 · 不可确认'
                    : '当前查看方案'}
                </small>
                <strong>¥{plan.total.toLocaleString()}</strong>
              </div>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  confirmed === plan.id ||
                  disabled ||
                  plan.deliveryAudit?.status !== 'passed' ||
                  plan.budget?.confirmable === false ||
                  plan.parts.some(
                    (part) =>
                      !matchesRequirementColor(part, result.requirements),
                  )
                }
                onClick={() => select(plan.id, true)}
              >
                {busy
                  ? '正在审核…'
                  : confirmed === plan.id
                    ? '已确认这套主机'
                    : '确认这套主机'}
              </Button>
            </div>
          </TabsContent>
        ))}
      </Tabs>
      <MonitorRecommendation
        key={JSON.stringify([
          result.requirements.purpose,
          result.monitorRecommendation?.criteria,
        ])}
        taskId={taskId}
        recommendation={result.monitorRecommendation}
        taskVersion={taskVersion}
        onChange={onChange}
        hostReady={result.plans.length > 0}
        defaultPurpose={result.requirements.purpose}
        disabled={disabled}
      />
    </>
  );
}
