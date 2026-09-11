'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Cpu, Send, Plus, ArrowUpRight, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { readResponse } from './api';
import Results from './results';
import GenerationProgress from './generation-progress';
import { updateProgress } from './progress-state';
import { loadWorkspace } from './workspace-session';
import { labels, type Catalog, type Category } from '@/backend/domain/types';
import type { ChatState } from '@/backend/agent/conversation';
import type { ChatStreamEvent, Progress } from '@/backend/agent/progress';
import { readLines } from '@/lib/stream';

const emptyState: ChatState = { draft: {}, messages: [], result: null };
const starter =
  '你好，我可以帮你选电脑，也可以一起排查电脑故障。\n想配主机，告诉我预算和用途；遇到故障，直接描述现象和屏幕提示。';
const sourceText = {
  user: '用户指定',
  assistant: '助手已选',
  confirmed: '用户已确认',
} as const;

export default function Chat() {
  const [state, setState] = useState<ChatState>(emptyState),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<Progress[]>([]),
    [loading, setLoading] = useState(true),
    [mobileView, setMobileView] = useState('chat'),
    [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null),
    currentTask = useRef(''),
    requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const followMessages = useRef(true);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    let active = true;
    Promise.all([
      loadWorkspace(),
      fetch('/api/catalog').then((r) => readResponse<Catalog>(r)),
    ])
      .then(([chat, items]) => {
        if (!active) return;
        setState(chat);
        currentTask.current = chat.currentTaskId ?? '';
        setCatalog(items);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (followMessages.current)
      end.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [state.messages.length, busy]);
  async function send(text = input) {
    // 发起请求时绑定任务和本地序号；切换任务后，迟到响应不得覆盖当前右栏。
    if (!text.trim() || busy || loading) return;
    followMessages.current = true;
    const requestTask = currentTask.current,
      version = ++requestVersion.current;
    setBusy(true);
    setProgress([{ scope: 'main', label: '连接当前任务', status: 'running' }]);
    const controller = new AbortController();
    activeRequest.current = controller;
    setError('');
    setInput('');
    setState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        { role: 'user', content: text, taskId: requestTask },
      ],
    }));
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        signal: controller.signal,
        body: JSON.stringify({ message: text, taskId: requestTask }),
      });
      if (!r.ok) await readResponse<ChatState>(r);
      if (!r.body) throw Error('没有收到处理进度，请重试');
      let data: ChatState | undefined;
      for await (const line of readLines(r.body)) {
        if (version !== requestVersion.current) return;
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ChatStreamEvent;
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'progress') {
          setProgress((items) => updateProgress(items, event.progress));
        }
        if (event.type === 'complete') {
          data = event.state;
          const savedPlans = data.result?.plans ?? [];
          setProgress((items) =>
            items.map((item) => {
              if (!item.generationId || item.scope === 'main') return item;
              const saved = savedPlans.find(
                (plan) => plan.id === item.plan?.id,
              );
              return saved
                ? {
                    ...item,
                    plan: saved,
                    status: 'done',
                    phase: 'complete',
                    label: '已审核并保存，可查看方案',
                  }
                : {
                    ...item,
                    plan: undefined,
                    status: 'error',
                    label: '此候选未纳入最终交付',
                  };
            }),
          );
        }
      }
      if (!data)
        throw Error('连接在处理完成前中断，已保存的需求可重新打开任务恢复');
      if (version !== requestVersion.current) return;
      if (currentTask.current === requestTask) {
        currentTask.current = data.currentTaskId ?? '';
        setState(data);
      } else
        setState((previous) => ({
          ...previous,
          tasks: data.tasks,
          messages: data.messages,
        }));
    } catch (e) {
      if (version === requestVersion.current)
        setError(e instanceof Error ? e.message : '发送失败，请重试');
      if (version === requestVersion.current)
        setProgress((items) =>
          items.map((item) => ({
            ...item,
            status: 'error',
            plan: undefined,
            label:
              item.scope === 'main'
                ? '本次处理未完成'
                : '生成中断，请刷新恢复已保存方案',
          })),
        );
    } finally {
      if (version === requestVersion.current) {
        setBusy(false);
        activeRequest.current = null;
      }
    }
  }
  async function reset() {
    requestVersion.current++;
    setError('');
    setBusy(true);
    try {
      const fresh = await readResponse<ChatState>(
        await fetch('/api/chat', { method: 'PUT' }),
      );
      currentTask.current = fresh.currentTaskId ?? '';
      setState(fresh);
      setProgress([]);
      setInput('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const d = state.draft,
    shownMessages = state.messages.filter(
      (m) => !m.taskId || m.taskId === state.currentTaskId,
    ),
    selectedParts =
      catalog?.parts.filter((p) =>
        Object.values(d.partSelections ?? {}).includes(p.id),
      ) ?? [],
    selectedSubtotal = selectedParts.reduce((sum, p) => sum + p.price, 0);
  const selection = (category: Category) => {
    const id = d.partSelections?.[category] ?? d.partPreferences?.[category],
      part = catalog?.parts.find((p) => p.id === id),
      source =
        d.selectionSources?.[category] ??
        (d.partPreferences?.[category] ? 'user' : undefined),
      series = d.seriesPreferences?.[category],
      authorization = d.selectionAuthorizations?.[category];
    return { part, source, series, authorization };
  };
  return (
    <div className="chat-app" data-mobile-view={mobileView}>
      <header>
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Cpu size={23} />
          </span>
          装机研究所<span className="version">PC ADVISOR</span>
        </Link>
        <div className="header-actions">
          <span className="connection">
            <i />
            任务记忆已开启
          </span>
          <Link href="/catalog">
            真实商品目录 <ArrowUpRight size={15} />
          </Link>
        </div>
      </header>
      <nav className="mobile-view-switch" aria-label="工作区视图">
        <button
          aria-pressed={mobileView === 'chat'}
          onClick={() => setMobileView('chat')}
        >
          对话
        </button>
        <button
          aria-pressed={mobileView === 'configuration'}
          onClick={() => setMobileView('configuration')}
        >
          配置{' '}
          {busy
            ? '· 生成中'
            : state.result?.plans.length
              ? `· ${state.result.plans.length} 套方案`
              : ''}
        </button>
      </nav>
      <main className="chat-main">
        <section className="chat-column">
          <div className="chat-heading">
            <div>
              <span className="eyebrow">电脑选购与故障排查</span>
              <h1>{state.task?.name ?? '我的主机'}</h1>
            </div>
            <Button
              variant="outline"
              disabled={busy || loading}
              onClick={reset}
            >
              <Plus size={16} />
              开始新会话
            </Button>
          </div>
          <div
            className="chat-scroll"
            aria-live="polite"
            onScroll={(event) => {
              const panel = event.currentTarget;
              followMessages.current =
                panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
            }}
          >
            {!shownMessages.length && (
              <div className="bubble-row assistant">
                <span className="avatar">
                  <Cpu size={19} />
                </span>
                <div className="bubble">{starter}</div>
              </div>
            )}
            {shownMessages.map((m, i) => (
              <div className={`bubble-row ${m.role}`} key={`${m.taskId}-${i}`}>
                {m.role === 'assistant' && (
                  <span className="avatar">
                    <Cpu size={19} />
                  </span>
                )}
                <div>
                  <div className="bubble">{m.content}</div>
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>
          <div className="composer-wrap">
            {!busy && !!state.result?.plans.length && (
              <button
                className="mobile-result-link"
                onClick={() => setMobileView('configuration')}
              >
                方案已生成，查看配置与报价 →
              </button>
            )}
            {busy && <GenerationProgress items={progress} />}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="composer">
              <Textarea
                aria-label="输入装机需求"
                placeholder="说说预算、用途，或者切换任务…"
                value={input}
                maxLength={2000}
                disabled={loading}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <Button
                aria-label="发送消息"
                disabled={busy || loading || !input.trim()}
                onClick={() => send()}
              >
                <Send size={19} />
              </Button>
            </div>
            <p className="composer-hint">Enter 发送 · Shift + Enter 换行</p>
          </div>
        </section>
        <aside className="configuration-column">
          <div className="configuration-heading">
            <div>
              <span>当前任务 · 第 {state.task?.version ?? 1} 版</span>
              <h2>配置工作区</h2>
            </div>
            <Layers size={19} />
          </div>
          <div className="requirement-tags" aria-label="当前需求">
            {d.budget ? (
              <span>
                预算 ¥{d.budget.toLocaleString()}
                {d.hardCap ? ' · 硬上限' : ''}
                {d.budgetTolerance !== undefined
                  ? ` · 误差≤¥${d.budgetTolerance}`
                  : ''}
              </span>
            ) : (
              <span className="unfilled">等待预算</span>
            )}
            {d.purpose ? (
              <span>{d.purpose}</span>
            ) : (
              <span className="unfilled">等待用途</span>
            )}
            <span>
              {d.mode === 'diy'
                ? 'DIY'
                : d.mode === 'prebuilt'
                  ? '整机'
                  : 'DIY 与整机均可'}
            </span>
            <span>
              {d.color && d.color !== '不限'
                ? `整套默认${d.color}`
                : '颜色不限'}
            </span>
            {Object.entries(d.partColors ?? {}).map(([category, color]) => (
              <span key={category}>
                {labels[category as Category]}：{color}
              </span>
            ))}
          </div>
          {!state.result?.plans.length && (
            <div className="selection-grid">
              {(Object.keys(labels) as Category[]).map((category) => {
                const item = selection(category);
                return (
                  <div key={category}>
                    <span>{labels[category]}</span>
                    {item.part ? (
                      <>
                        <b>
                          {item.part.brand} {item.part.name}
                        </b>
                        <small>
                          {sourceText[item.source ?? 'assistant']} · ¥
                          {item.part.price.toLocaleString()}
                        </small>
                      </>
                    ) : item.series ? (
                      <>
                        <b>{item.series}</b>
                        <small>
                          {item.authorization
                            ? '已限定系列 · 助手选择具体版本'
                            : '已限定系列 · 等待确认版本'}
                        </small>
                      </>
                    ) : (
                      <>
                        <b>待选择</b>
                        <small>尚未确定商品</small>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!state.result && selectedParts.length > 0 && (
            <p className="result-summary">
              已锁定 {selectedParts.length}/8 件，配件小计 ¥
              {selectedSubtotal.toLocaleString()}。完整后再计算整机总价。
            </p>
          )}
          {state.result ? (
            <Results
              key={state.currentTaskId}
              taskId={state.currentTaskId}
              disabled={busy}
              result={state.result}
              onChange={(result) =>
                setState((s) =>
                  s.currentTaskId === state.currentTaskId
                    ? {
                        ...s,
                        result,
                        draft: { ...s.draft, ...result.requirements },
                      }
                    : s,
                )
              }
            />
          ) : (
            <div className="configuration-empty">
              <h3>等待形成完整方案</h3>
              <p>
                需求和已选配件会显示在这里，八类完整后生成报价；DIY
                方案另做兼容性检查。
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
