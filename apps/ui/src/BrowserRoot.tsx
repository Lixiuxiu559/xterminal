import { useEffect, useRef, useState, type FormEvent } from 'react';
import { App } from './App';
import { BrowserTransport, fetchBootstrap, transportError } from './browserTransport';
import { Icon } from './icons';

interface Ticket { ticket: string; expiresAtMs: number }
export function BrowserRoot() {
  const [client, setClient] = useState<BrowserTransport | null>(null);
  const [phase, setPhase] = useState<'connecting' | 'pairing'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [deviceName, setDeviceName] = useState('我的手机');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [now, setNow] = useState(Date.now());
  const transport = useRef<BrowserTransport | null>(null);
  useEffect(() => {
    let active = true;
    let created: BrowserTransport | undefined;
    setPhase('connecting'); setError('');
    void fetchBootstrap().then(snapshot => {
      if (!active) return;
      created = new BrowserTransport(snapshot, { onUnauthorized: () => {
        if (!active) return;
        transport.current = null; setClient(null); setTicket(null); setCode(''); setPhase('pairing'); setError('设备授权已失效，请重新配对。');
      } });
      transport.current = created;
      created.onEvent(event => { if (active && event.type === 'catalog.changed') { setClient(created!); setError(''); } });
      void created.start().then(() => { if (active) setClient(created!); }).catch(() => { if (active) setError('暂时无法连接电脑，正在重新连接。请保持电脑端共享已开启。'); });
    }).catch(cause => {
      if (!active) return;
      if ((cause as { code?: string }).code === 'UNAUTHENTICATED') { setPhase('pairing'); setError(''); }
      else { setPhase('connecting'); setError(cause instanceof Error ? cause.message : '无法连接电脑，请稍后重试。'); }
    });
    return () => { active = false; created?.dispose(); if (transport.current === created) transport.current = null; };
  }, [attempt]);
  useEffect(() => {
    if (!ticket) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticket]);
  useEffect(() => {
    if (!ticket) return;
    let active = true;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!active) return;
      if (Date.now() >= ticket!.expiresAtMs) { setTicket(null); setError('配对申请已过期，请使用电脑上的新配对码重试。'); return; }
      try {
        const response = await fetch(`/api/v1/pairing/requests/${encodeURIComponent(ticket!.ticket)}`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal });
        const result = await response.json();
        if (!active) return;
        if (!response.ok) throw transportError(result.error?.code ?? 'PAIRING_FAILED', result.error?.message ?? '无法读取配对状态。');
        if (result.status === 'approved') { setTicket(null); setCode(''); setAttempt(value => value + 1); return; }
        if (result.status === 'rejected') { setTicket(null); setError('电脑端已拒绝此设备。确认设备名称后，可以重新申请。'); return; }
      } catch (cause) {
        if (!active) return;
        const key = (cause as { code?: string }).code;
        if (['UNAUTHENTICATED', 'PAIRING_EXPIRED', 'TICKET_EXPIRED', 'NOT_FOUND'].includes(key ?? '')) { setTicket(null); setError('配对申请已失效，请重新申请。'); return; }
        setError('暂时无法读取配对状态，正在重试；请检查电脑端是否仍开启连接。');
      }
      if (active) timer = setTimeout(() => { void poll(); }, 2000);
    }
    void poll();
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, [ticket]);
  async function pair(event: FormEvent) {
    event.preventDefault();
    if (submitting || !/^\d{8}$/.test(code) || !deviceName.trim()) return;
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/v1/pairing/requests', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: deviceName.trim() }) });
      const result = await response.json();
      if (!response.ok) throw transportError(result.error?.code ?? 'PAIRING_FAILED', result.error?.message ?? '配对申请未成功，请检查配对码。');
      if (result.status !== 'pending' || typeof result.ticket !== 'string' || !Number.isFinite(result.expiresAtMs)) throw new Error('配对响应无效，请重新申请。');
      setTicket({ ticket: result.ticket, expiresAtMs: result.expiresAtMs }); setNow(Date.now()); setCode('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '配对失败，请稍后重试。'); }
    finally { setSubmitting(false); }
  }
  if (client) return <App client={client} />;
  return <main className="browser-entry"><section className="pairing-card"><span className="empty-art"><Icon name="phone" /></span><span className="eyebrow">XTERMINAL · 连接电脑</span><h1>{ticket ? '在电脑上确认这台设备' : phase === 'connecting' ? '正在连接你的工作空间' : '把工作空间带到手机上'}</h1>
    {ticket ? <><p className="muted">已发送“{deviceName}”的配对申请。请在电脑端打开“连接手机”，核对设备名称后允许。</p><div className="pairing-wait" role="status"><i className="dot" />等待电脑批准 · {Math.max(0, Math.ceil((ticket.expiresAtMs - now) / 1000))} 秒</div><button className="secondary" onClick={() => { setTicket(null); setError(''); }}>取消等待</button></> : phase === 'pairing' ? <form onSubmit={event => { void pair(event); }}><p className="muted">电脑与手机连接同一内网，在电脑端开启“连接手机”，获取 8 位配对码。</p><label htmlFor="device-name">设备名称</label><input id="device-name" value={deviceName} onChange={event => setDeviceName(event.target.value)} maxLength={60} autoComplete="off" disabled={submitting} required /><label htmlFor="pair-code">电脑上的配对码</label><input className="pair-code-input" id="pair-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" maxLength={8} placeholder="输入 8 位数字" disabled={submitting} required /><button className="primary" disabled={submitting || !/^\d{8}$/.test(code) || !deviceName.trim()}>{submitting ? '正在申请…' : '申请配对'}<Icon name="arrow" /></button></form> : <><p className="muted">正在读取电脑上的项目与会话。连接中断时，请保持电脑端共享已开启。</p><button className="secondary" onClick={() => { setClient(null); setAttempt(value => value + 1); }}>重新连接</button></>}
    {error && <p className="form-error" role="alert">{error}</p>}<p className="pairing-security">连接通过已信任的 HTTPS 证书加密。配对须在电脑端批准；关闭此页面不会停止电脑上的任务。</p>
  </section></main>;
}
