import { useEffect, useRef, useState } from 'react';
import type { AppMethod, DesktopBridge, RequestMap } from '../../../packages/protocol/src/desktop';
import type { LanState, LanMode } from '../../../packages/protocol/src/lan';
import { Icon } from './icons';

type LanMethod = Extract<AppMethod, 'lan.enable' | 'lan.disable' | 'lan.rotateCode' | 'lan.approve' | 'lan.reject' | 'lan.revoke'>;
interface ActiveCode { origin: string; code: string; expiresAtMs: number }
export function LanPanel({ bridge }: { bridge: DesktopBridge }) {
  const [state, setState] = useState<LanState | null>(null);
  const [address, setAddress] = useState('');
  const [mode, setMode] = useState<LanMode>('http');
  const [activeCode, setActiveCode] = useState<ActiveCode | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const version = useRef(0);
  const currentOrigin = useRef<string | null>(null);
  function apply(next: LanState) {
    if (!alive.current) return;
    const priorOrigin = currentOrigin.current;
    currentOrigin.current = next.enabled ? next.origin : null;
    setState(next);
    if (next.enabled && next.mode) setMode(next.mode);
    setAddress(previous => next.enabled && next.origin ? new URL(next.origin).hostname : next.interfaces.some(network => network.address === previous) ? previous : next.interfaces[0]?.address || '');
    if (!next.enabled || !next.origin || priorOrigin !== next.origin) setActiveCode(null);
    if (next.enabled && next.origin && next.pairingCode && next.pairingExpiresAtMs) setActiveCode({ origin: next.origin, code: next.pairingCode, expiresAtMs: next.pairingExpiresAtMs });
  }
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    const unsubscribe = bridge.onEvent(event => { if (!disposed && event.type === 'lan.changed') { version.current += 1; apply(event.state); } });
    const initial = version.current;
    bridge.invoke('lan.status', {}).then(result => { if (!disposed && version.current === initial) apply(result); }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : '无法读取连接设置。'); });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; alive.current = false; unsubscribe(); clearInterval(timer); };
  }, [bridge]);
  useEffect(() => { if (activeCode && activeCode.expiresAtMs <= now) setActiveCode(null); }, [activeCode, now]);
  async function run<K extends LanMethod>(method: K, params: RequestMap[K]['params']) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    const startVersion = version.current;
    try {
      const result = await bridge.invoke(method, params);
      if (!alive.current) return;
      if (startVersion === version.current) apply(result);
      else if (result.enabled && result.origin && result.origin === currentOrigin.current && result.pairingCode && result.pairingExpiresAtMs) setActiveCode({ origin: result.origin, code: result.pairingCode, expiresAtMs: result.pairingExpiresAtMs });
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '操作未完成，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function exportCertificate() {
    setBusy(true); setError(''); setNotice('');
    try { const result = await bridge.invoke('lan.exportCertificate', {}); if (alive.current) setNotice(result.saved ? 'CA 证书已导出。请将证书安全传到手机，并在系统设置中安装、启用信任。' : '已取消导出。'); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '证书导出失败。'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function refresh() {
    setBusy(true); setError('');
    const startVersion = version.current;
    try { const result = await bridge.invoke('lan.status', {}); if (alive.current && startVersion === version.current) apply(result); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '无法读取连接设置。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const code = activeCode && activeCode.origin === state?.origin && activeCode.expiresAtMs > now ? activeCode : null;
  if (bridge.kind === 'browser') return <div><h2>已连接电脑</h2><p className="muted">连接设置与设备授权由电脑端管理。关闭本页不会停止电脑上的任务。</p></div>;
  return <section className="lan-panel" aria-label="手机连接设置"><h1>离开桌面，继续工作</h1><p className="muted">在同一可信内网访问此电脑上的项目与会话。连接默认关闭，由你开启与授权。</p>
    {!state ? <button className="secondary" disabled={busy} onClick={() => { void refresh(); }}>重新读取设置</button> : <>
      <div className="lan-section"><div className="lan-section-heading"><h2>内网连接</h2><span className={`lan-status ${state.enabled ? 'enabled' : ''}`}><i className={`dot ${state.enabled ? '' : 'quiet'}`} />{state.enabled ? '已开启' : '已关闭'}</span></div><label htmlFor="lan-mode">连接模式</label><select id="lan-mode" value={mode} onChange={event => setMode(event.target.value as LanMode)} disabled={busy || state.enabled}><option value="http">HTTP 简便模式（无需证书）</option><option value="https">HTTPS 加密模式</option></select><p className="muted">{mode === 'http' ? '连接未加密，仅用于可信家庭网络或个人热点，不用于公共 Wi-Fi。' : '连接加密；手机需要安装并信任本地 CA 证书。'}切换模式须先关闭共享并重新配对。</p><label htmlFor="lan-address">共享使用的私有 IP 地址</label><select id="lan-address" value={address} onChange={event => setAddress(event.target.value)} disabled={busy || state.enabled}>{state.interfaces.map(network => <option key={`${network.name}-${network.address}`} value={network.address}>{network.address} · {network.name}</option>)}</select>{!state.interfaces.length && <p className="muted">未找到可用私有 IP，请先连接本地网络。</p>}<div className="lan-actions">{state.enabled ? <button className="secondary" disabled={busy} onClick={() => { void run('lan.disable', {}); }}>关闭连接</button> : <button className="primary" disabled={busy || !address} onClick={() => { void run('lan.enable', { address, mode }); }}>开启内网连接<Icon name="arrow" /></button>}</div></div>
      {state.enabled && state.origin && <>{state.mode === 'https' && <div className="lan-section"><h2>1. 在手机上信任证书</h2><p className="muted">先导出本地 CA 证书，安全传到你的手机。在手机系统设置中安装证书并明确启用信任，再打开下方地址。证书与设备配对是两步独立操作。</p><button className="secondary" disabled={busy || !state.certificateReady} onClick={() => { void exportCertificate(); }}>导出 CA 证书</button></div>}<div className="lan-section"><h2>{state.mode === 'https' ? '2. 打开地址并申请配对' : '打开地址并申请配对'}</h2><div className="lan-origin"><code>{state.origin}</code><button className="secondary" onClick={() => { void navigator.clipboard.writeText(state.origin!).then(() => setNotice('连接地址已复制。')).catch(() => setError('复制失败，请手动复制地址。')); }}>复制地址</button></div><p className="muted">手机输入下方配对码后，还需在这台电脑上允许设备。</p><div className="lan-pairing-code"><div><span>8 位配对码</span><strong>{code ? `${code.code.slice(0, 4)} ${code.code.slice(4)}` : '配对码已隐藏或过期'}</strong><small>{code ? `${Math.max(0, Math.ceil((code.expiresAtMs - now) / 1000))} 秒后过期` : '点击获取新配对码，有效期 120 秒'}</small></div><button className="secondary" disabled={busy} onClick={() => { void run('lan.rotateCode', {}); }}>{code ? '刷新配对码' : '获取配对码'}</button></div></div></>}
      <div className="lan-section"><h2>等待你确认 <span>{state.pending.length}</span></h2>{state.pending.length ? state.pending.map(request => <div className="lan-device" key={request.ticket}><Icon name="phone" /><div><b>{request.deviceName}</b><small>{request.expiresAtMs > now ? `${Math.ceil((request.expiresAtMs - now) / 1000)} 秒内可确认` : '申请已过期'}</small></div><button className="secondary" disabled={busy || request.expiresAtMs <= now} onClick={() => { void run('lan.reject', { ticket: request.ticket }); }}>拒绝</button><button className="primary" disabled={busy || request.expiresAtMs <= now} onClick={() => { void run('lan.approve', { ticket: request.ticket }); }}>允许设备</button></div>) : <p className="muted">暂无配对申请。请只允许你认识的设备。</p>}</div>
      <div className="lan-section"><h2>已配对设备</h2>{state.devices.filter(device => !device.revokedAtMs).length ? state.devices.filter(device => !device.revokedAtMs).map(device => <div className="lan-device" key={device.id}><Icon name="phone" /><div><b>{device.name}</b><small>{device.expiresAtMs > now ? `有效至 ${new Date(device.expiresAtMs).toLocaleDateString('zh-CN')}` : '授权已过期'}</small></div><button className="secondary" disabled={busy} onClick={() => { void run('lan.revoke', { deviceId: device.id }); }}>撤销访问</button></div>) : <p className="muted">还没有已配对设备。</p>}</div>
    </>}{error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="lan-notice" role="status">{notice}</p>}
  </section>;
}
