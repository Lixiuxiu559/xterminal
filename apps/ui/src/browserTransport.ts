import { randomId } from './randomId.ts';
import type { AppEvent, AppMethod, Bootstrap, DesktopBridge, RequestMap, RpcResponse } from '../../../packages/protocol/src/desktop.ts';
import type { ControlLease, ControlStamp } from '../../../packages/protocol/src/index.ts';

const MAX_REQUEST_BYTES = 65_536;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING = 128;
const controlled = new Set<AppMethod>(['control.renew', 'control.release', 'agent.turn.start', 'agent.turn.stop', 'agent.respond', 'shell.start', 'shell.input', 'shell.resize', 'shell.terminate']);
const encoder = new TextEncoder();
export function transportError(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }
export async function fetchBootstrap(): Promise<Bootstrap> {
  const response = await fetch('/api/v1/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) throw transportError('UNAUTHENTICATED', '设备尚未配对或授权已过期。');
  const body = await response.json();
  if (!response.ok) throw transportError(body.error?.code ?? 'CONNECTION_FAILED', body.error?.message ?? '暂时无法连接电脑。');
  return body as Bootstrap;
}
export function ownLeases(snapshot: Bootstrap, principalId: string): Map<string, ControlLease> {
  return new Map(snapshot.sessions.filter(session => session.control?.principalId === principalId).map(session => [session.id, session.control!]));
}
interface Pending {
  method: AppMethod; params: unknown; version: number;
  resolve: (value: unknown) => void; reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface TransportOptions {
  onUnauthorized: () => void;
  origin?: string;
  createSocket?: (url: string) => WebSocket;
  probe?: () => Promise<Bootstrap>;
}
export class BrowserTransport implements DesktopBridge {
  readonly kind = 'browser' as const;
  readonly principalId: string;
  private readonly options: TransportOptions;
  private socket: WebSocket | null = null;
  private listeners = new Set<(event: AppEvent) => void>();
  private pending = new Map<string, Pending>();
  private leases: Map<string, ControlLease>;
  private catalog: Bootstrap;
  private catalogVersion = 0;
  private generation = 0;
  private stopped = false;
  private authenticated = true;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private renewing = new Set<string>();

  constructor(snapshot: Bootstrap, options: TransportOptions) {
    if (!snapshot.principalId?.startsWith('device:')) throw transportError('UNAUTHENTICATED', '设备身份无效，请重新配对。');
    this.principalId = snapshot.principalId; this.catalog = snapshot; this.options = options;
    this.leases = ownLeases(snapshot, this.principalId);
  }
  onEvent(listener: (event: AppEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  selectProject(): Promise<never> { return Promise.reject(transportError('FORBIDDEN', '请在电脑端添加项目目录。')); }
  private emit(event: AppEvent) { for (const listener of this.listeners) { try { listener(event); } catch { /* One view must not stop other subscribers. */ } } }
  async start(): Promise<void> {
    if (this.stopped) throw transportError('DISCONNECTED', '连接已关闭。');
    if (!this.heartbeat) this.heartbeat = setInterval(() => { this.renewOwned(); }, 5000);
    await this.connect();
  }
  private acceptCatalog(snapshot: Bootstrap) {
    if (snapshot.principalId && snapshot.principalId !== this.principalId) throw transportError('UNAUTHENTICATED', '设备身份已变化，请重新配对。');
    this.catalog = snapshot; this.leases = ownLeases(snapshot, this.principalId);
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const origin = this.options.origin ?? location.origin;
    const url = new URL('/api/v1/stream', origin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('连接协议无效');
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let settled = false;
      let failureReason: string | undefined;
      const settle = (error?: unknown) => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      let socket: WebSocket;
      try { socket = this.options.createSocket?.(url.href) ?? new WebSocket(url.href); }
      catch (error) { settle(error); void this.recover(); return; }
      this.socket = socket;
      // All listeners are attached before the first RPC so restoration cannot miss live catalog events.
      socket.addEventListener('message', event => {
        if (this.stopped || generation !== this.generation) return;
        try { this.receive(event.data); }
        catch (error) { failureReason = error instanceof Error ? error.message : '收到的消息格式无效。'; socket.close((error as { code?: string }).code === 'FRAME_TOO_LARGE' ? 1009 : 1002, 'INVALID_FRAME'); }
      });
      socket.addEventListener('open', () => {
        opened = true;
        void this.invoke('bootstrap', {}).then(snapshot => {
          if (this.stopped || generation !== this.generation) return;
          this.reconnectAttempt = 0;
          this.emit({ type: 'catalog.changed', snapshot }); settle();
        }).catch(error => { settle(error); socket.close(); });
      });
      socket.addEventListener('error', () => { if (!opened) settle(transportError('CONNECTION_FAILED', '暂时无法连接电脑，正在重新连接。')); });
      socket.addEventListener('close', event => {
        if (generation !== this.generation || this.stopped) return;
        this.socket = null; this.leases.clear();
        this.rejectPending(transportError('RESULT_UNCONFIRMED', `${failureReason ?? '连接已断开。'}操作结果未确认，未自动重发。`));
        this.emit({ type: 'host.offline', message: failureReason ?? '与电脑的连接已断开。草稿已保留，未确认的操作不会自动重发。' });
        settle(transportError('DISCONNECTED', '与电脑的连接已断开。'));
        if (event.code === 1008 && /DEVICE_REVOKED|UNAUTHENTICATED/.test(event.reason)) this.unauthorized();
        else void this.recover();
      });
    });
  }
  private receive(data: unknown) {
    if (typeof data !== 'string' || encoder.encode(data).byteLength > MAX_FRAME_BYTES) throw transportError('FRAME_TOO_LARGE', '收到的数据过大或格式无效。');
    const value = JSON.parse(data);
    if (!value || typeof value !== 'object') throw transportError('INVALID_FRAME', '消息格式无效。');
    if (typeof value.id === 'string' && typeof value.ok === 'boolean') {
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      const response = value as RpcResponse;
      if (!response.ok) { pending.reject(transportError(response.error?.code ?? 'REQUEST_FAILED', response.error?.message ?? '操作未完成。')); return; }
      let result = response.result;
      try {
        if (pending.method === 'bootstrap') {
          if (pending.version === this.catalogVersion) this.acceptCatalog(result as Bootstrap);
          result = this.catalog;
        } else if (pending.version === this.catalogVersion) {
          const sessionId = (pending.params as { sessionId?: string }).sessionId;
          if (pending.method === 'session.create') {
            const session = result as Bootstrap['sessions'][number];
            if (session.control?.principalId === this.principalId) this.leases.set(session.id, session.control);
          } else if ((pending.method === 'control.acquire' || pending.method === 'control.renew') && sessionId) {
            const lease = result as ControlLease;
            if (lease.principalId === this.principalId) this.leases.set(sessionId, lease);
          } else if (pending.method === 'control.release' && sessionId) this.leases.delete(sessionId);
        }
        pending.resolve(result);
      } catch (error) { pending.reject(error); }
      return;
    }
    // Phones only receive these product events. Desktop LAN management data is never forwarded to views.
    if (value.type === 'catalog.changed') {
      this.catalogVersion += 1; this.acceptCatalog(value.snapshot as Bootstrap); this.emit(value as AppEvent);
    } else if (['agent.changed', 'terminal.output', 'host.offline'].includes(value.type)) this.emit(value as AppEvent);
  }
  invoke<K extends AppMethod>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']> {
    if (method.startsWith('lan.')) return Promise.reject(transportError('FORBIDDEN', '连接设置仅可在电脑端管理。'));
    const socket = this.socket;
    if (this.stopped || !socket || socket.readyState !== 1) return Promise.reject(transportError('DISCONNECTED', '连接未就绪，请等待重新连接。'));
    if (this.pending.size >= MAX_PENDING) return Promise.reject(transportError('TOO_MANY_REQUESTS', '等待确认的操作过多，请稍后重试。'));
    const sessionId = (params as { sessionId?: string }).sessionId;
    const lease = sessionId ? this.leases.get(sessionId) : undefined;
    let control: ControlStamp | undefined;
    if (controlled.has(method)) {
      if (!lease || lease.expiresAtMs <= Date.now()) return Promise.reject(transportError('CONTROL_REQUIRED', '当前为只读查看，请先接管操作。'));
      control = { hostInstanceId: lease.hostInstanceId, generation: lease.generation };
    }
    const id = randomId();
    const data = JSON.stringify({ id, method, params, ...(control ? { control } : {}) });
    const bytes = encoder.encode(data).byteLength;
    if (bytes > MAX_REQUEST_BYTES) return Promise.reject(transportError('PAYLOAD_TOO_LARGE', '本次请求超过 64 KiB，请缩短输入后重试。'));
    if (socket.bufferedAmount + bytes > MAX_FRAME_BYTES) return Promise.reject(transportError('SEND_BUFFER_FULL', '网络发送缓冲已满，请等待连接恢复后再操作。'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(transportError('RESULT_UNCONFIRMED', '未及时收到确认，操作结果不确定，未自动重发。')); }, 30_000);
      this.pending.set(id, { method, params, version: this.catalogVersion, resolve: resolve as (value: unknown) => void, reject, timer });
      try { socket.send(data); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(transportError('RESULT_UNCONFIRMED', '发送中断，操作结果未确认，未自动重发。')); }
    });
  }
  private renewOwned() {
    if (!this.socket || this.socket.readyState !== 1) return;
    for (const [sessionId, lease] of this.leases) {
      if (lease.expiresAtMs <= Date.now()) { this.leases.delete(sessionId); continue; }
      if (this.renewing.has(sessionId)) continue;
      this.renewing.add(sessionId);
      void this.invoke('control.renew', { sessionId }).catch(error => {
        if (['CONTROL_REQUIRED', 'STALE_CONTROL'].includes((error as { code?: string }).code ?? '')) this.leases.delete(sessionId);
      }).finally(() => this.renewing.delete(sessionId));
    }
  }
  private async recover() {
    if (this.stopped || !this.authenticated || this.reconnectTimer) return;
    try { await (this.options.probe ?? fetchBootstrap)(); }
    catch (error) { if ((error as { code?: string }).code === 'UNAUTHENTICATED') { this.unauthorized(); return; } }
    if (this.stopped || !this.authenticated || this.reconnectTimer) return;
    const delay = Math.min(15_000, 1000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch(() => { /* close handler schedules the next attempt; never replay RPCs. */ });
    }, delay);
  }
  private unauthorized() { if (!this.authenticated) return; this.authenticated = false; this.dispose(); this.options.onUnauthorized(); }
  private rejectPending(error: unknown) { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear(); }
  dispose() {
    this.stopped = true; this.generation += 1; clearTimeout(this.reconnectTimer); clearInterval(this.heartbeat);
    this.socket?.close(); this.socket = null; this.leases.clear();
    this.rejectPending(transportError('RESULT_UNCONFIRMED', '连接已关闭，未确认的操作不会自动重发。'));
    this.listeners.clear();
  }
}
