'use client';
import Link from 'next/link';
import type { RecommendationResult } from '@/backend/domain/types';
import { readResponse } from './api';
import { useState, useEffect } from 'react';
import Results from './results';
import { registerConfigurationTool } from './web-tools';
import { Cpu, ArrowUpRight, Layers, Check, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

export default function Home() {
  const [budget, setBudget] = useState('6000');
  const [purpose, setPurpose] = useState('游戏');
  const [mode, setMode] = useState('both');
  const [color, setColor] = useState('不限');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<RecommendationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/session')
      .then((r) => readResponse<RecommendationResult | null>(r))
      .then((d) => {
        if (d?.requirements) {
          setResult({ ...d, summary: '已恢复上次的配置。' });
          setBudget(String(d.requirements.budget));
          setPurpose(d.requirements.purpose);
          setMode(d.requirements.mode);
          setColor(d.requirements.color);
          setMessage(d.requirements.message);
        }
      })
      .catch(() => {});
  }, []);
  useEffect(
    () =>
      registerConfigurationTool((data) => {
        setResult(data);
        setBudget(String(data.requirements.budget));
        setPurpose(data.requirements.purpose);
        setMode(data.requirements.mode);
        setColor(data.requirements.color);
        setMessage(data.requirements.message);
      }),
    [],
  );
  async function recommend() {
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          budget: Number(budget),
          purpose,
          mode,
          color,
          message,
        }),
      });
      const data = await readResponse<RecommendationResult>(r);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '请求失败，请重试');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="workspace">
      <header>
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Cpu size={23} />
          </span>{' '}
          装机研究所 <span className="version">BETA / 01</span>
        </Link>
        <Link href="/catalog">
          商品目录 <ArrowUpRight size={16} />
        </Link>
      </header>
      <main>
        <div className="intro">
          <span className="eyebrow">YOUR NEXT BUILD</span>
          <h1>把预算，花在对的配置上。</h1>
          <p>从你的用途出发，搭配一台适合你的主机。</p>
        </div>
        <div className="workgrid">
          <section className="brief">
            <div className="section-title">
              <span className="step">01</span>
              <h2>告诉我你的需求</h2>
            </div>
            <label htmlFor="budget">
              主机预算 <span>人民币</span>
            </label>
            <div className="money">
              <b>¥</b>
              <Input
                id="budget"
                type="number"
                min="1"
                max="1000000"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
            <p className="hint">方案与预算差额不超过 ¥1,000</p>
            <p className="field-label" id="purpose-label">
              主要用途
            </p>
            <div className="chips">
              {['游戏', '办公', '剪辑设计', '编程', '本地 AI'].map((p) => (
                <Button
                  key={p}
                  variant="outline"
                  className={purpose === p ? 'active' : ''}
                  onClick={() => setPurpose(p)}
                >
                  {p}
                </Button>
              ))}
            </div>
            <div className="fields">
              <div>
                <label id="mode-label" htmlFor="mode">
                  购买方式
                </label>
                <Select value={mode} onValueChange={(v) => v && setMode(v)}>
                  <SelectTrigger id="mode" aria-labelledby="mode-label">
                    <SelectValue>
                      {
                        (
                          {
                            diy: 'DIY 自由搭配',
                            prebuilt: '已组装整机',
                            both: '两种都看看',
                          } as Record<string, string>
                        )[mode]
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries({
                      diy: 'DIY 自由搭配',
                      prebuilt: '已组装整机',
                      both: '两种都看看',
                    }).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label id="color-label" htmlFor="color">
                  机箱颜色
                </label>
                <Select value={color} onValueChange={(v) => v && setColor(v)}>
                  <SelectTrigger id="color" aria-labelledby="color-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['不限', '黑色', '白色'].map((c) => (
                      <SelectItem value={c} key={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label htmlFor="message">
              还有什么想法？ <span>选填</span>
            </label>
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="例如：最多 6000 元，主要玩 CS2，机箱想要白色"
            />
            <Button
              className="submit"
              disabled={busy || !Number(budget)}
              onClick={recommend}
            >
              {busy ? '正在匹配配置…' : '生成我的配置'}
              <ArrowRight size={18} />
            </Button>
            <p className="demo-note">
              当前为演示商品与演示报价，非实际销售承诺。
            </p>
          </section>
          <section className="results" aria-live="polite">
            <div className="section-title">
              <span className="step">02</span>
              <h2>你的配置方案</h2>
              <span className="muted">DIY × 整机</span>
            </div>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {!result ? (
              <div className="empty">
                <Layers size={42} />
                <h3>好配置，从明确需求开始</h3>
                <p>
                  填写预算和用途，我们会比较商品目录中的组合，
                  <br />
                  检查兼容性，再给你可调整的方案。
                </p>
                <div className="promises">
                  <span>
                    <Check size={15} /> 八类完整配件
                  </span>
                  <span>
                    <Check size={15} /> 服务端预算校验
                  </span>
                </div>
              </div>
            ) : (
              <Results result={result} onChange={setResult} />
            )}
          </section>
        </div>
        <footer>
          <span>装机研究所 / PC ADVISOR</span>
          <span>先确定主机，再考虑显示器。</span>
        </footer>
      </main>
    </div>
  );
}
