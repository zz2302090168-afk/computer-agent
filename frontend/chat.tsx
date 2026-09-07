'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Cpu,
  Send,
  Plus,
  ArrowUpRight,
  Check,
  MessageCircle,
  Layers,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { readResponse } from './api';
import Results from './results';
import { labels, type Catalog, type Category } from '@/backend/domain/types';
import type { ChatState } from '@/backend/agent/conversation';

const emptyState: ChatState = { draft: {}, messages: [], result: null };
const starter =
  '你好，我来帮你配主机。大概准备花多少钱，主要用来做什么？\n不懂硬件也没关系，比如：“6000 元左右，主要玩游戏”。';
// 模块生命周期内复用初始化请求，避免 StrictMode 重复执行；整页刷新会重新创建。
let initialWorkspace: Promise<ChatState> | undefined;
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
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null),
    currentTask = useRef(''),
    requestVersion = useRef(0);
  useEffect(() => {
    Promise.all([
      (initialWorkspace ??= fetch('/api/chat', { method: 'PUT' }).then((r) =>
        readResponse<ChatState>(r),
      )),
      fetch('/api/catalog').then((r) => readResponse<Catalog>(r)),
    ])
      .then(([chat, items]) => {
        setState(chat);
        currentTask.current = chat.currentTaskId ?? '';
        setCatalog(items);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [state.messages.length, busy]);
  async function send(text = input) {
    // 发起请求时绑定任务和本地序号；切换任务后，迟到响应不得覆盖当前右栏。
    if (!text.trim() || busy || loading) return;
    const requestTask = currentTask.current,
      version = ++requestVersion.current;
    setBusy(true);
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, taskId: requestTask }),
        }),
        data = await readResponse<ChatState>(r);
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
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  async function switchTo(taskId: string) {
    setError('');
    try {
      const r = await fetch('/api/chat', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId }),
        }),
        data = await readResponse<ChatState>(r);
      currentTask.current = data.currentTaskId ?? '';
      setState(data);
    } catch (e) {
      setError((e as Error).message);
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
    <div className="chat-app">
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
      <main className="chat-main">
        <section className="chat-column">
          <div className="task-switcher" aria-label="配机任务">
            {state.tasks?.map((t) => (
              <button
                key={t.id}
                className={t.id === state.currentTaskId ? 'active' : ''}
                onClick={() => switchTo(t.id)}
              >
                <b>{t.name}</b>
                <small>
                  {t.budget ? `¥${t.budget}` : '等待预算'} ·{' '}
                  {t.purpose ?? '等待用途'}
                </small>
              </button>
            ))}
          </div>
          <div className="chat-heading">
            <div>
              <span className="eyebrow">CURRENT TASK</span>
              <h1>{state.task?.name ?? '我的主机'}</h1>
            </div>
            <Button
              variant="outline"
              disabled={busy || loading}
              onClick={reset}
            >
              <Plus size={16} />
              清空全部任务
            </Button>
          </div>
          <div className="chat-scroll" aria-live="polite">
            <div className="bubble-row assistant">
              <span className="avatar">
                <Cpu size={19} />
              </span>
              <div className="bubble">{starter}</div>
            </div>
            {shownMessages.map((m, i) => (
              <div className={`bubble-row ${m.role}`} key={`${m.taskId}-${i}`}>
                {m.role === 'assistant' && (
                  <span className="avatar">
                    <Cpu size={19} />
                  </span>
                )}
                <div>
                  <div className="bubble">{m.content}</div>
                  {m.toolsUsed?.length ? (
                    <div className="tool-trace">
                      {m.toolsUsed.map((t) => (
                        <span key={t}>
                          <Check size={11} />
                          {t}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy && (
              <div className="bubble-row assistant">
                <span className="avatar">
                  <Cpu size={19} />
                </span>
                <div className="bubble pending">正在更新当前任务…</div>
              </div>
            )}
            {!shownMessages.length && !busy && (
              <div className="conversation-examples">
                {[
                  '6000元游戏主机，5070你自己选',
                  '8000元，白色主机，做剪辑',
                  '另外帮朋友配一台办公电脑',
                ].map((t) => (
                  <button key={t} disabled={loading} onClick={() => send(t)}>
                    <MessageCircle size={15} />
                    {t}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            )}
            <div ref={end} />
          </div>
          <div className="composer-wrap">
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
            <p className="composer-hint">
              Enter 发送 · Shift + Enter 换行<span>先配主机，再聊显示器</span>
            </p>
          </div>
        </section>
        <aside className="configuration-column">
          <div className="configuration-heading">
            <div>
              <span className="eyebrow">
                TASK VERSION {state.task?.version ?? 1}
              </span>
              <h2>实时需求与配置</h2>
            </div>
            <Layers size={21} />
          </div>
          <div className="requirement-tags">
            {d.budget ? (
              <span>
                预算 ¥{d.budget.toLocaleString()}
                {d.hardCap ? ' · 硬上限' : ''}
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
              {d.color && d.color !== '不限' ? `${d.color}机箱` : '颜色不限'}
            </span>
          </div>
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
                        {sourceText[item.source ?? 'assistant']} · 商家目录价 ¥
                        {item.part.price}
                      </small>
                    </>
                  ) : item.series ? (
                    <>
                      <b>{item.series}</b>
                      <small>
                        {item.authorization
                          ? '已限定系列 · 具体版本由助手选择'
                          : '已限定系列 · 等待确认版本'}
                      </small>
                    </>
                  ) : (
                    <>
                      <b>待选择</b>
                      <small>尚未确定具体商品</small>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {!state.result && selectedParts.length > 0 && (
            <p className="result-summary">
              已选配件小计 ¥{selectedSubtotal.toLocaleString()}
              。尚未形成完整主机，不代表整机总价。
            </p>
          )}
          {state.result ? (
            <Results
              key={state.currentTaskId}
              result={state.result}
              onChange={(result) => setState((s) => ({ ...s, result }))}
            />
          ) : (
            <div className="configuration-empty">
              <h3>任务尚未形成完整方案</h3>
              <p>
                已明确的需求和配件会持续保存在上方。八类完整后才计算整机总价并校验兼容性。
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
