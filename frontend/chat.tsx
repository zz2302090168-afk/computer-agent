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
import {
  loadWorkspace,
  pageSessionHeaders,
  startNewPageSession,
} from './workspace-session';
import {
  applyPlanActionResponse,
  applyRequirementSnapshot,
  applyWorkspaceResponse,
} from './result-state';
import { labels, type Catalog, type Category } from '@/backend/domain/types';
import type { ChatState } from '@/backend/agent/conversation';
import type { ChatStreamEvent, Progress } from '@/backend/agent/progress';
import { readLines } from '@/lib/stream';
import { beginChatTiming } from './chat-timing';
import { catalogMessageParts } from './catalog-links';

const emptyState: ChatState = { draft: {}, messages: [], result: null };
const starter =
  '你好，我可以帮你选电脑，也可以一起排查电脑故障。\n想配主机，告诉我预算和用途；遇到故障，直接描述现象和屏幕提示。';
const sourceText = {
  user: '用户指定',
  assistant: '助手已选',
  confirmed: '用户已确认',
} as const;

const inquiryPrompt = (name: string) =>
  `我想咨询“${name}”这台组装整机，请介绍当前售价和八类配置。先了解商品，不修改或确认我的方案。`;

function clearInquiryLocation() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('prebuilt')) return;
  url.searchParams.delete('prebuilt');
  window.history.replaceState(
    null,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

export default function Chat({
  active: visible = true,
  consultPrebuiltId,
}: { active?: boolean; consultPrebuiltId?: string } = {}) {
  const [state, setState] = useState<ChatState>(emptyState),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [input, setInput] = useState(''),
    [inquiry, setInquiry] = useState<{ id: string; name: string } | null>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState<Progress[]>([]),
    [loading, setLoading] = useState(true),
    [mobileView, setMobileView] = useState('chat'),
    [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null),
    currentTask = useRef(''),
    requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const timing = useRef<ReturnType<typeof beginChatTiming> | null>(null);
  const chatColumn = useRef<HTMLElement>(null);
  useEffect(() => {
    const commit = () =>
      timing.current?.commit(
        visible && !!chatColumn.current?.getClientRects().length,
        !busy,
      );
    commit();
    document.addEventListener('visibilitychange', commit);
    return () => document.removeEventListener('visibilitychange', commit);
  }, [state, progress, busy, error, visible, mobileView]);
  const followMessages = useRef(true);
  useEffect(() => () => activeRequest.current?.abort(), []);
  useEffect(() => {
    let active = true;
    const initialize = () => {
      const version = ++requestVersion.current;
      Promise.all([
        loadWorkspace(),
        fetch('/api/catalog').then((r) => readResponse<Catalog>(r)),
      ])
        .then(([chat, items]) => {
          if (!active || version !== requestVersion.current) return;
          setState(chat);
          currentTask.current = chat.currentTaskId ?? '';
          setCatalog(items);
        })
        .catch((e) => {
          if (active && version === requestVersion.current) setError(e.message);
        })
        .finally(() => {
          if (active && version === requestVersion.current) setLoading(false);
        });
    };
    const resumePage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      activeRequest.current?.abort();
      activeRequest.current = null;
      currentTask.current = '';
      setState(emptyState);
      setProgress([]);
      setError('');
      setInput('');
      setInquiry(null);
      setBusy(false);
      setLoading(true);
      initialize();
    };
    initialize();
    window.addEventListener('pageshow', resumePage);
    return () => {
      active = false;
      window.removeEventListener('pageshow', resumePage);
    };
  }, []);
  useEffect(() => {
    if (!visible || busy || loading || !consultPrebuiltId) return;
    let active = true;
    // 等本轮处理结束后独立读取咨询商品，不重置聊天；目录可能在浏览期间更新。
    fetch('/api/catalog')
      .then((response) => readResponse<Catalog>(response))
      .then((items) => {
        if (!active) return;
        setCatalog(items);
        const pc = items.prebuilts.find(
          (item) => item.id === consultPrebuiltId,
        );
        if (!pc)
          throw Error('这台整机已不在当前商品目录中，请返回目录重新选择。');
        setInquiry({ id: pc.id, name: pc.name });
        setInput(inquiryPrompt(pc.name));
        clearInquiryLocation();
      })
      .catch((cause) => {
        if (!active) return;
        setInquiry(null);
        setInput('');
        setError(cause instanceof Error ? cause.message : '咨询商品读取失败');
        clearInquiryLocation();
      });
    return () => {
      active = false;
    };
  }, [visible, busy, loading, consultPrebuiltId]);
  useEffect(() => {
    if (visible && followMessages.current)
      end.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [state.messages, busy, visible]);
  async function send(text = input) {
    // 发起请求时绑定本轮状态；新会话后的迟到响应不得覆盖当前右栏。
    if (!text.trim() || busy || loading || consultPrebuiltId) return;
    const requestTiming = beginChatTiming();
    timing.current = requestTiming;
    followMessages.current = true;
    const requestTask = currentTask.current,
      version = ++requestVersion.current,
      sessionHeaders = pageSessionHeaders(),
      requestInquiry = inquiry,
      replyId = crypto.randomUUID();
    setBusy(true);
    setProgress([{ scope: 'main', label: '处理本次对话', status: 'running' }]);
    const controller = new AbortController();
    activeRequest.current = controller;
    setError('');
    setInput('');
    setState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          role: 'user',
          content: text,
          taskId: requestTask,
          ...(requestInquiry ? { consultPrebuiltId: requestInquiry.id } : {}),
        },
      ],
    }));
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          ...sessionHeaders,
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        signal: controller.signal,
        body: JSON.stringify({
          message: text,
          taskId: requestTask,
          ...(requestInquiry ? { consultPrebuiltId: requestInquiry.id } : {}),
        }),
      });
      requestTiming.connect(r.headers.get('X-Chat-Trace-Id'));
      if (!r.ok) await readResponse<ChatState>(r);
      if (!r.body) throw Error('没有收到处理进度，请重试');
      let data: ChatState | undefined;
      for await (const line of readLines(r.body)) {
        if (version !== requestVersion.current) return;
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ChatStreamEvent;
        requestTiming.receive(
          event.type,
          (event.type === 'text' && !!event.text) ||
            (event.type === 'complete' &&
              event.state.messages.at(-1)?.role === 'assistant' &&
              !!event.state.messages.at(-1)?.content),
        );
        if (event.type === 'error') throw Error(event.error);
        if (event.type === 'text') {
          setState((previous) => ({
            ...previous,
            messages: [
              ...previous.messages.filter((entry) => entry.id !== replyId),
              ...(event.text
                ? [
                    {
                      id: replyId,
                      role: 'assistant' as const,
                      content: event.text,
                      taskId: requestTask,
                    },
                  ]
                : []),
            ],
          }));
        }
        if (event.type === 'progress') {
          setProgress((items) => updateProgress(items, event.progress));
        }
        if (event.type === 'requirements') {
          setState((previous) =>
            applyRequirementSnapshot(previous, event.task),
          );
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
                    label: '已完成审核，可查看方案',
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
      if (!data) throw Error('连接在处理完成前中断，请在当前页面重试');
      if (version !== requestVersion.current) return;
      setInquiry((current) => (current === requestInquiry ? null : current));
      if (currentTask.current === requestTask) {
        currentTask.current = data.currentTaskId ?? '';
        setState((previous) => applyWorkspaceResponse(previous, data));
      } else
        setState((previous) => ({
          ...previous,
          tasks: data.tasks,
          messages: data.messages,
        }));
    } catch (e) {
      requestTiming.fail(controller.signal.aborted);
      if (version === requestVersion.current)
        setState((previous) => ({
          ...previous,
          messages: previous.messages.filter((entry) => entry.id !== replyId),
        }));
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
                : '生成中断，请在当前页面重试',
          })),
        );
      // 工具可能已更新本页面临时状态；保留错误，重新读取当前版本。
      if (!controller.signal.aborted && version === requestVersion.current) {
        try {
          const recovered = await readResponse<ChatState>(
            await fetch('/api/chat', {
              cache: 'no-store',
              headers: sessionHeaders,
              signal: controller.signal,
            }),
          );
          if (version === requestVersion.current) {
            currentTask.current = recovered.currentTaskId ?? '';
            setState((previous) =>
              applyWorkspaceResponse(previous, {
                ...recovered,
                messages:
                  recovered.currentTaskId === requestTask
                    ? previous.messages
                    : recovered.messages,
              }),
            );
          }
        } catch {
          // 重新读取也失败时保留原始错误，不把旧页面状态标成已同步。
        }
      }
    } finally {
      if (version === requestVersion.current) {
        setBusy(false);
        activeRequest.current = null;
      }
    }
  }
  async function reset() {
    timing.current?.dispose();
    timing.current = null;
    performance.clearMeasures('chat.request');
    const version = ++requestVersion.current,
      previousSession = pageSessionHeaders()['x-page-session'];
    activeRequest.current?.abort();
    activeRequest.current = null;
    setError('');
    setBusy(true);
    try {
      const fresh = await startNewPageSession();
      if (version !== requestVersion.current) return;
      currentTask.current = fresh.currentTaskId ?? '';
      setState(fresh);
      setProgress([]);
      setInput('');
      setInquiry(null);
    } catch (e) {
      if (version === requestVersion.current) {
        if (pageSessionHeaders()['x-page-session'] !== previousSession) {
          currentTask.current = '';
          setState(emptyState);
          setProgress([]);
          setInput('');
          setInquiry(null);
        }
        setError((e as Error).message);
      }
    } finally {
      if (version === requestVersion.current) setBusy(false);
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
            本次对话不保留
          </span>
          <Link href="/catalog?kind=prebuilt">
            商品目录 <ArrowUpRight size={15} />
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
            ? '· 处理中'
            : state.result?.plans.length
              ? `· ${state.result.plans.length} 套方案`
              : ''}
        </button>
      </nav>
      <main className="chat-main">
        <section className="chat-column" ref={chatColumn}>
          <div className="chat-heading">
            <div>
              <span className="eyebrow">电脑选购与故障排查</span>
              <h1>{state.task?.name ?? '我的主机'}</h1>
            </div>
            <Button
              variant="outline"
              disabled={busy || loading || !!consultPrebuiltId}
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
                  <div className="bubble">
                    {m.role === 'assistant'
                      ? catalogMessageParts(m.content).map((part, index) =>
                          part.href ? (
                            <Link key={index} href={part.href}>
                              {part.text}
                            </Link>
                          ) : (
                            part.text
                          ),
                        )
                      : m.content}
                  </div>
                </div>
              </div>
            ))}
            <div ref={end} />
          </div>
          <div className="composer-wrap">
            {inquiry && (
              <div className="catalog-inquiry" aria-label="本次咨询商品">
                <div>
                  <span>正在咨询组装整机</span>
                  <strong>{inquiry.name}</strong>
                </div>
                <Button
                  variant="ghost"
                  disabled={busy || !!consultPrebuiltId}
                  onClick={() => {
                    if (input === inquiryPrompt(inquiry.name)) setInput('');
                    setInquiry(null);
                    clearInquiryLocation();
                  }}
                >
                  移除商品
                </Button>
              </div>
            )}
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
                placeholder="说说预算、用途，或者描述电脑故障…"
                value={input}
                maxLength={2000}
                disabled={loading || !!consultPrebuiltId}
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
                disabled={
                  busy || loading || !!consultPrebuiltId || !input.trim()
                }
                onClick={() => send()}
              >
                <Send size={19} />
              </Button>
            </div>
            <p className="composer-hint">
              Enter 发送 · Shift + Enter 换行 · 刷新页面会清空本次对话
            </p>
          </div>
        </section>
        <aside className="configuration-column">
          <div className="configuration-heading">
            <div>
              <span>本次对话</span>
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
                          {item.part.demo ? '演示商品' : '真实型号'} ·{' '}
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
              taskVersion={state.task?.version}
              disabled={busy}
              result={state.result}
              onChange={(result) =>
                setState((s) => applyPlanActionResponse(s, result))
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
