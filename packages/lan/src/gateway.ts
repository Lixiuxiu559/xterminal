import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { isIPv4 } from 'node:net';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { ensureCertificates } from './certificates.ts';
import { FileDeviceRepository, validateDevice } from './repository.ts';
import type { AppEvent, RpcResponse } from '../../protocol/src/desktop.ts';
import type { DeviceRecord, DeviceSummary, DeviceRepository, LanAddress, LanGatewayOptions, LanGatewayApi, LanStarted, LanTestDependencies, PairingCode, PairingRequest } from './types.ts';

const PAIR_TTL = 120000;
const DEVICE_TTL = 7 * 86400000;
const RATE_WINDOW = 10 * 60000;
const MAX_MESSAGE = 1024 * 1024;
const MAX_COMMAND = 64 * 1024;
const DEVICE_COOKIE = '__Host-xterminal-device';
const PAIR_COOKIE = '__Host-xterminal-pairing';
const ALLOWED_METHODS = new Set([
  'bootstrap', 'session.create', 'session.rename', 'shell.start', 'shell.input', 'shell.resize', 'shell.snapshot', 'shell.terminate',
  'agent.snapshot', 'agent.turn.start', 'agent.turn.stop', 'agent.respond', 'engine.models', 'control.acquire', 'control.renew', 'control.release',
]);
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');
const principal = (device: DeviceRecord): string => `device:${device.id}`;
const summary = ({ tokenHash: _, ...device }: DeviceRecord): DeviceSummary => device;
const equalHash = (left: string, right: string): boolean => timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));

interface Ticket extends PairingRequest { secretHash: string; status: 'pending' | 'approved' | 'rejected' | 'claiming' }
interface Client { deviceId: string; pending: number; pendingBytes: number; queue: Promise<void> }
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second! >= 16 && second! <= 31) || (first === 192 && second === 168);
}

export class LanGateway implements LanGatewayApi {
  readonly #options: LanGatewayOptions;
  readonly #repository: DeviceRepository;
  readonly #now: () => number;
  #address: LanAddress | null = null;
  #caCertificatePath: string | null = null;
  #server?: Server;
  #wss?: WebSocketServer;
  #starting?: Promise<LanStarted>;
  #stopping?: Promise<void>;
  #stopRequested = false;
  #devices = new Map<string, DeviceRecord>();
  #devicesLoaded?: Promise<void>;
  #dirtyRevocations = new Set<string>();
  #revocationWrites = new Map<string, Promise<void>>();
  #claimsInFlight = new Set<Promise<void>>();
  #tokenIndex = new Map<string, string>();
  #tickets = new Map<string, Ticket>();
  #clients = new Map<WebSocket, Client>();
  #codeHash: string | null = null;
  #codeSalt = '';
  #codeExpiry = 0;
  #failures = new Map<string, { count: number; until: number }>();
  #globalFailures = { count: 0, until: 0 };
  #sweeper?: ReturnType<typeof setInterval>;
  #expiryNotified = new Set<string>();

  constructor(options: LanGatewayOptions, testDependencies: LanTestDependencies = {}) {
    if (!isPrivateIPv4(options.bindAddress) && !(testDependencies.allowLoopback && options.bindAddress === '127.0.0.1')) {
      throw new Error('LAN 只能绑定显式 RFC1918 私有 IPv4 地址');
    }
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error('LAN 端口无效');
    this.#options = options;
    this.#repository = options.repository ?? new FileDeviceRepository(options.dataPath);
    this.#now = testDependencies.now ?? Date.now;
  }
  get address(): LanAddress | null { return this.#address ? { ...this.#address } : null; }
  get caCertificatePath(): string | null { return this.#caCertificatePath; }

  start(): Promise<LanStarted> {
    if (this.#starting) return this.#starting;
    if (this.#address || this.#stopping) return Promise.reject(new Error('LAN 已启动或正在关闭'));
    this.#stopRequested = false;
    const starting = this.#start();
    this.#starting = starting;
    void starting.finally(() => { if (this.#starting === starting) this.#starting = undefined; }).catch(() => {});
    return starting;
  }
  async #start(): Promise<LanStarted> {
    try {
      await this.#loadDevices();
      const certificates = await ensureCertificates(this.#options.dataPath, this.#options.bindAddress);
      if (this.#stopRequested) throw new Error('LAN 启动已取消');
      this.#caCertificatePath = certificates.caCertificatePath;
      const server = createServer({ key: certificates.key, cert: certificates.cert, minVersion: 'TLSv1.2', maxHeaderSize: 16384 }, (request, response) => {
        request.on('error', () => {}); response.on('error', () => {});
        void this.#http(request, response).catch((error: unknown) => this.#httpError(response, error));
      });
      this.#server = server;
      server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
      server.on('clientError', (_error, socket) => socket.destroy());
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false, clientTracking: false });
      this.#wss = wss;
      server.on('upgrade', (request, socket, head) => this.#upgrade(request, socket, head));
      await new Promise<void>((resolveListen, reject) => {
        const onError = (error: Error): void => { server.off('listening', onListening); reject(error); };
        const onListening = (): void => { server.off('error', onError); resolveListen(); };
        server.once('error', onError); server.once('listening', onListening);
        server.listen(this.#options.port ?? 0, this.#options.bindAddress);
      });
      const bound = server.address();
      if (!bound || typeof bound === 'string') throw new Error('LAN 监听失败');
      this.#address = { bindAddress: this.#options.bindAddress, port: bound.port, origin: new URL(`https://${this.#options.bindAddress}:${bound.port}`).origin };
      if (this.#stopRequested) throw new Error('LAN 启动已取消');
      server.on('error', () => { void this.stop().catch(() => {}); });
      this.#sweeper = setInterval(() => this.#sweep(), 1000);
      this.#sweeper.unref();
      return { address: this.address!, caCertificatePath: certificates.caCertificatePath, pairingCode: this.rotatePairingCode() };
    } catch (error) {
      this.#wss?.close(); this.#wss = undefined;
      if (this.#server?.listening) await new Promise<void>((resolveClose) => this.#server!.close(() => resolveClose()));
      this.#server = undefined; this.#address = null;
      throw error;
    }
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#stopRequested = true;
    const stopping = (async () => {
      if (this.#starting) await this.#starting.catch(() => {});
      this.#codeHash = null; this.#tickets.clear();
      if (this.#sweeper) clearInterval(this.#sweeper);
      this.#sweeper = undefined;
      for (const socket of this.#clients.keys()) socket.terminate();
      this.#clients.clear();
      this.#wss?.close(); this.#wss = undefined;
      const server = this.#server;
      this.#server = undefined; this.#address = null;
      let persistenceError: unknown;
      try { await this.#loadDevices(); } catch (error) { persistenceError = error; }
      // A claim may already be committing when access is disabled. It must
      // complete its compensating revocation before storage can be closed.
      for (const result of await Promise.allSettled([...this.#claimsInFlight])) {
        if (result.status === 'rejected' && !(result.reason instanceof HttpError && result.reason.code === 'PAIRING_EXPIRED')) persistenceError = result.reason;
      }
      // Disabling LAN invalidates existing grants, rather than reviving old cookies on re-enable.
      for (const device of this.#devices.values()) {
        if (device.revokedAtMs === null || this.#dirtyRevocations.has(device.id)) {
          try { await this.revokeDevice(device.id); } catch (error) { persistenceError = error; }
        }
      }
      if (server?.listening) {
        await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); });
      }
      if (persistenceError) throw persistenceError;
    })();
    this.#stopping = stopping;
    void stopping.finally(() => { if (this.#stopping === stopping) this.#stopping = undefined; }).catch(() => {});
    return stopping;
  }

  rotatePairingCode(): PairingCode {
    if (!this.#address || this.#stopRequested) throw new Error('LAN 尚未开启');
    const code = String(randomInt(100000000)).padStart(8, '0');
    this.#codeSalt = secret(); this.#codeHash = hash(this.#codeSalt + code); this.#codeExpiry = this.#now() + PAIR_TTL;
    return { code, expiresAtMs: this.#codeExpiry };
  }
  async approvePairing(ticket: string): Promise<void> {
    const pending = this.#tickets.get(ticket);
    if (!pending || pending.expiresAtMs <= this.#now() || pending.status !== 'pending' || !this.#address) throw new Error('配对申请已失效');
    pending.status = 'approved';
  }
  rejectPairing(ticket: string): void {
    const pending = this.#tickets.get(ticket);
    if (!pending || pending.expiresAtMs <= this.#now() || pending.status !== 'pending') throw new Error('配对申请已失效');
    pending.status = 'rejected';
  }
  #loadDevices(): Promise<void> {
    if (this.#devicesLoaded) return this.#devicesLoaded;
    const loaded = (async () => {
      const records = await this.#repository.list();
      if (records.length > 10000) throw new Error('设备授权数量超过上限');
      const devices = new Map<string, DeviceRecord>(); const tokens = new Map<string, string>();
      for (const value of records) {
        const device = validateDevice(value);
        if (devices.has(device.id) || tokens.has(device.tokenHash)) throw new Error('设备授权存储存在重复身份');
        devices.set(device.id, device); tokens.set(device.tokenHash, device.id);
      }
      for (const [id, device] of devices) this.#devices.set(id, device);
      for (const [token, id] of tokens) this.#tokenIndex.set(token, id);
    })();
    this.#devicesLoaded = loaded;
    void loaded.catch(() => { if (this.#devicesLoaded === loaded) this.#devicesLoaded = undefined; });
    return loaded;
  }
  async listDevices(): Promise<DeviceSummary[]> { await this.#loadDevices(); return [...this.#devices.values()].map(summary); }
  async revokeDevice(deviceId: string): Promise<void> {
    await this.#loadDevices();
    const device = this.#devices.get(deviceId);
    if (!device) throw new Error('设备不存在');
    if (device.revokedAtMs !== null && !this.#dirtyRevocations.has(deviceId)) return;
    if (device.revokedAtMs === null) {
      const revoked = { ...device, revokedAtMs: this.#now() };
      this.#devices.set(deviceId, revoked); this.#tokenIndex.delete(device.tokenHash);
      this.#dirtyRevocations.add(deviceId);
      for (const [socket, client] of this.#clients) if (client.deviceId === deviceId) this.#disconnect(socket, 'DEVICE_REVOKED');
      this.#notifyRevoked(revoked);
    }
    const existing = this.#revocationWrites.get(deviceId);
    if (existing) return existing;
    const revoked = this.#devices.get(deviceId)!;
    const write = Promise.resolve().then(() => this.#repository.upsert(revoked)).then(() => {
      this.#dirtyRevocations.delete(deviceId);
    }).finally(() => {
      if (this.#revocationWrites.get(deviceId) === write) this.#revocationWrites.delete(deviceId);
    });
    this.#revocationWrites.set(deviceId, write);
    await write;
  }
  broadcast(event: AppEvent): void {
    // Desktop configuration is never part of the mobile event stream, including
    // while the shared AppEvent union is being extended by the Host.
    if ((event as { type: string }).type === 'lan.changed') return;
    const frame = event.type === 'catalog.changed' ? null : JSON.stringify(event);
    for (const [socket, client] of this.#clients) {
      const device = this.#authorizedDevice(client.deviceId);
      if (!device) { this.#disconnect(socket, 'DEVICE_REVOKED'); continue; }
      const deviceFrame = event.type === 'catalog.changed'
        ? JSON.stringify({ ...event, snapshot: { ...event.snapshot, principalId: principal(device) } })
        : frame!;
      this.#send(socket, deviceFrame);
    }
  }
  #notifyRevoked(device: DeviceRecord): void {
    if (this.#expiryNotified.has(device.id)) return;
    this.#expiryNotified.add(device.id);
    try { this.#options.onDeviceRevoked(principal(device)); } catch { /* observers cannot preserve a revoked grant */ }
  }
  #authorizedDevice(id: string): DeviceRecord | null {
    const device = this.#devices.get(id);
    if (!device || device.revokedAtMs !== null) return null;
    if (device.expiresAtMs <= this.#now()) { this.#notifyRevoked(device); return null; }
    return device;
  }
  #authenticate(request: IncomingMessage): DeviceRecord | null {
    const cookie = this.#cookie(request, DEVICE_COOKIE);
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return null;
    const id = this.#tokenIndex.get(hash(cookie));
    return id ? this.#authorizedDevice(id) : null;
  }
  #authenticationFailure(request: IncomingMessage): HttpError {
    const cookie = this.#cookie(request, DEVICE_COOKIE);
    if (cookie && /^[A-Za-z0-9_-]{43}$/.test(cookie)) {
      const tokenHash = hash(cookie);
      const device = [...this.#devices.values()].find((candidate) => candidate.tokenHash === tokenHash);
      if (device && (device.revokedAtMs !== null || device.expiresAtMs <= this.#now())) {
        return new HttpError(401, 'DEVICE_REVOKED', '设备授权已失效，请重新配对');
      }
    }
    return new HttpError(401, 'UNAUTHENTICATED', '设备尚未授权，请重新配对');
  }
  #cookie(request: IncomingMessage, name: string): string | null {
    const header = request.headers.cookie;
    if (!header || header.length > 8192) return null;
    let result: string | null = null;
    for (const item of header.split(';')) {
      const separator = item.indexOf('=');
      if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
      if (result !== null) return null;
      result = item.slice(separator + 1).trim();
    }
    return result;
  }
  #checkRequest(request: IncomingMessage, requireOrigin: boolean): string {
    if (!this.#address || this.#stopRequested) throw new HttpError(503, 'LAN_DISABLED', '内网访问已关闭');
    if (request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'host').length !== 1) throw new HttpError(403, 'FORBIDDEN', 'Host 不允许');
    if (request.headers.host !== new URL(this.#address.origin).host) throw new HttpError(403, 'FORBIDDEN', 'Host 不允许');
    const origin = request.headers.origin;
    if ((requireOrigin && origin !== this.#address.origin) || (origin !== undefined && origin !== this.#address.origin)) throw new HttpError(403, 'FORBIDDEN', 'Origin 不允许');
    const site = request.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'FORBIDDEN', '跨站请求不允许');
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) throw new HttpError(400, 'INVALID_REQUEST', '请求路径无效');
    try { return decodeURIComponent(new URL(request.url, this.#address.origin).pathname); }
    catch { throw new HttpError(400, 'INVALID_REQUEST', '请求路径无效'); }
  }
  #headers(response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    response.setHeader('Cache-Control', 'no-store');
  }
  #json(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_MESSAGE) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '响应过大，需要重新同步');
    this.#headers(response); response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Content-Length', Buffer.byteLength(json)); response.end(json);
  }
  #httpError(response: ServerResponse, error: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    const known = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', '请求无法完成');
    this.#json(response, known.status, { error: { code: known.code, message: known.message } });
  }
  async #body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'INVALID_REQUEST', '需要 JSON 请求');
    const body = await new Promise<Buffer>((resolveBody, reject) => {
      let bytes = 0; const chunks: Buffer[] = [];
      const cleanup = (): void => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
      const onData = (chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > MAX_COMMAND) {
          cleanup(); request.resume(); reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求超过 64 KiB')); return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => { cleanup(); resolveBody(Buffer.concat(chunks)); };
      const onError = (): void => { cleanup(); reject(new HttpError(400, 'INVALID_REQUEST', '请求中断')); };
      const onAborted = (): void => onError();
      request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
    });
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new HttpError(400, 'INVALID_REQUEST', 'JSON 请求无效'); }
  }
  async #http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = this.#checkRequest(request, request.method !== 'GET' && request.method !== 'HEAD');
    if (request.method === 'GET' && path === '/healthz') { this.#json(response, 200, { ok: true, protocolVersion: 1 }); return; }
    if (request.method === 'POST' && path === '/api/v1/pairing/requests') { await this.#pair(request, response); return; }
    const match = /^\/api\/v1\/pairing\/requests\/([A-Za-z0-9_-]{43})$/.exec(path);
    if (request.method === 'GET' && match) {
      const claim = this.#claim(request, response, match[1]!);
      this.#claimsInFlight.add(claim);
      try { await claim; } finally { this.#claimsInFlight.delete(claim); }
      return;
    }
    if (path.startsWith('/api/')) {
      const device = this.#authenticate(request);
      if (!device) throw this.#authenticationFailure(request);
      if (request.method === 'GET' && path === '/api/v1/bootstrap') {
        const result = await this.#options.bootstrap(principal(device));
        if (!this.#authorizedDevice(device.id)) throw new HttpError(401, 'DEVICE_REVOKED', '设备授权已失效');
        this.#json(response, 200, result); return;
      }
      throw new HttpError(404, 'NOT_FOUND', '接口不存在');
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '方法不允许');
    await this.#static(response, path, request.method === 'HEAD');
  }
  #checkRate(ip: string): void {
    const now = this.#now();
    if (this.#globalFailures.until <= now) this.#globalFailures = { count: 0, until: now + RATE_WINDOW };
    const failure = this.#failures.get(ip);
    if ((failure && failure.until > now && failure.count >= 5) || this.#globalFailures.count >= 100) throw new HttpError(429, 'RATE_LIMITED', '配对失败次数过多，请稍后重试');
  }
  #failedCode(ip: string): void {
    const now = this.#now();
    const failure = this.#failures.get(ip);
    this.#failures.set(ip, { count: failure && failure.until > now ? failure.count + 1 : 1, until: failure && failure.until > now ? failure.until : now + RATE_WINDOW });
    this.#globalFailures.count++;
    if (this.#failures.size > 4096) this.#failures.delete(this.#failures.keys().next().value!);
  }
  async #pair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ip = request.socket.remoteAddress ?? 'unknown';
    this.#checkRate(ip);
    let body: Record<string, unknown>;
    try { body = await this.#body(request); }
    catch (error) { this.#failedCode(ip); throw error; }
    // Bodies may arrive concurrently; check again after the asynchronous read so
    // parallel guesses cannot all pass the same pre-read failure count.
    this.#checkRate(ip);
    const code = body.code;
    if (typeof code !== 'string' || !/^\d{8}$/.test(code) || !this.#codeHash || this.#codeExpiry <= this.#now() || !equalHash(hash(this.#codeSalt + code), this.#codeHash)) {
      this.#failedCode(ip);
      throw new HttpError(403, 'PAIRING_EXPIRED', '配对码无效或已过期');
    }
    if (typeof body.deviceName !== 'string' || !body.deviceName.trim() || body.deviceName.length > 80 || /[\x00-\x1f\x7f]/.test(body.deviceName)) throw new HttpError(400, 'INVALID_REQUEST', '设备名称无效');
    this.#sweep();
    if (this.#tickets.size >= 128) throw new HttpError(429, 'RATE_LIMITED', '待处理配对申请过多');
    this.#codeHash = null; // Single-use; only an explicit local rotate reveals another code.
    const ticket = secret(); const applicantSecret = secret(); const now = this.#now();
    const pending: Ticket = { ticket, deviceName: body.deviceName.trim(), requestedAtMs: now, expiresAtMs: now + PAIR_TTL, secretHash: hash(applicantSecret), status: 'pending' };
    this.#tickets.set(ticket, pending);
    response.setHeader('Set-Cookie', `${PAIR_COOKIE}=${applicantSecret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=120`);
    try { this.#options.onPairingRequest({ ticket, deviceName: pending.deviceName, requestedAtMs: now, expiresAtMs: pending.expiresAtMs }); }
    catch { this.#tickets.delete(ticket); throw new HttpError(500, 'INTERNAL_ERROR', '配对确认暂不可用'); }
    this.#json(response, 202, { ticket, expiresAtMs: pending.expiresAtMs, status: 'pending' });
  }
  async #claim(request: IncomingMessage, response: ServerResponse, ticket: string): Promise<void> {
    const pending = this.#tickets.get(ticket);
    if (!pending || pending.expiresAtMs <= this.#now()) { this.#tickets.delete(ticket); throw new HttpError(410, 'PAIRING_EXPIRED', '配对申请已过期'); }
    const applicantSecret = this.#cookie(request, PAIR_COOKIE);
    if (!applicantSecret || applicantSecret.length > 128 || !equalHash(hash(applicantSecret), pending.secretHash)) throw new HttpError(403, 'FORBIDDEN', '配对申请不属于此客户端');
    if (pending.status !== 'approved') { this.#json(response, pending.status === 'claiming' ? 409 : 200, { status: pending.status }); return; }
    if (this.#devices.size >= 10000) throw new HttpError(429, 'RATE_LIMITED', '设备授权数量超过上限');
    pending.status = 'claiming';
    const token = secret(); const now = this.#now();
    const device: DeviceRecord = { id: randomUUID(), name: pending.deviceName, tokenHash: hash(token), createdAtMs: now, expiresAtMs: now + DEVICE_TTL, revokedAtMs: null };
    try { await this.#repository.upsert(device); }
    catch { this.#tickets.delete(ticket); throw new HttpError(503, 'STORAGE_UNAVAILABLE', '无法保存设备授权'); }
    this.#devices.set(device.id, device);
    if (this.#stopRequested || pending.expiresAtMs <= this.#now() || this.#tickets.get(ticket) !== pending) {
      await this.revokeDevice(device.id);
      this.#tickets.delete(ticket); throw new HttpError(410, 'PAIRING_EXPIRED', '配对申请已过期');
    }
    this.#tokenIndex.set(device.tokenHash, device.id); this.#tickets.delete(ticket);
    response.setHeader('Set-Cookie', [
      `${DEVICE_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_TTL / 1000}`,
      `${PAIR_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
    ]);
    this.#json(response, 200, { status: 'approved', device: summary(device), principalId: principal(device) });
  }
  async #static(response: ServerResponse, path: string, head: boolean): Promise<void> {
    if (path.includes('\0') || path.includes('\\') || path.split('/').some((part) => part.startsWith('.'))) throw new HttpError(400, 'INVALID_REQUEST', '静态路径无效');
    const root = await realpath(this.#options.uiPath);
    const candidate = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!candidate.startsWith(root + sep)) throw new HttpError(403, 'FORBIDDEN', '静态路径不允许');
    let file: string;
    try { file = await realpath(candidate); }
    catch { throw new HttpError(404, 'NOT_FOUND', '页面不存在'); }
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new HttpError(404, 'NOT_FOUND', '页面不存在');
    const size = (await stat(file)).size;
    if (size > 16 * MAX_MESSAGE) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '静态资源过大');
    this.#headers(response); response.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream'); response.setHeader('Content-Length', size);
    if (head) response.end(); else response.end(await readFile(file));
  }
  #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const path = this.#checkRequest(request, true);
      if (path !== '/api/v1/stream') throw new HttpError(404, 'NOT_FOUND', '接口不存在');
      const device = this.#authenticate(request);
      if (!device) throw this.#authenticationFailure(request);
      this.#wss!.handleUpgrade(request, socket, head, (websocket) => this.#connect(websocket, device));
    } catch (error) {
      const known = error instanceof HttpError ? error : new HttpError(400, 'INVALID_REQUEST', '请求无效');
      const body = JSON.stringify({ error: { code: known.code, message: known.message } });
      socket.end(`HTTP/1.1 ${known.status} Rejected\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-store\r\nX-XTerminal-Error: ${known.code}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    }
  }
  #connect(socket: WebSocket, device: DeviceRecord): void {
    if (!this.#authorizedDevice(device.id) || this.#stopRequested) { this.#disconnect(socket, 'DEVICE_REVOKED'); return; }
    if (this.#clients.size >= 128) { this.#disconnect(socket, 'RATE_LIMITED'); return; }
    const client: Client = { deviceId: device.id, pending: 0, pendingBytes: 0, queue: Promise.resolve() };
    this.#clients.set(socket, client);
    socket.on('error', () => socket.terminate());
    socket.once('close', () => this.#clients.delete(socket));
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1003, 'JSON_REQUIRED'); return; }
      const data = raw.toString(); const bytes = Buffer.byteLength(data);
      if (bytes > MAX_COMMAND) { this.#send(socket, JSON.stringify({ id: '', ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: '命令超过 64 KiB' } })); return; }
      if (client.pending >= 32 || client.pendingBytes + bytes > MAX_MESSAGE) { socket.close(1008, 'RESYNC_REQUIRED'); return; }
      client.pending++; client.pendingBytes += bytes;
      client.queue = client.queue.then(async () => {
        if (socket.readyState !== WebSocket.OPEN || !this.#authorizedDevice(device.id)) { socket.close(1008, 'DEVICE_REVOKED'); return; }
        let id = '';
        try {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_REQUEST', 'RPC 请求无效');
          const request = parsed as Record<string, unknown>;
          if (typeof request.id !== 'string' || !request.id || request.id.length > 128 || typeof request.method !== 'string' || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new HttpError(400, 'INVALID_REQUEST', 'RPC 请求无效');
          id = request.id;
          if (!ALLOWED_METHODS.has(request.method)) throw new HttpError(403, 'FORBIDDEN', '此方法不允许从手机调用');
          const sanitized = { id, method: request.method, params: request.params, ...(request.control !== undefined ? { control: request.control } : {}) };
          const result: RpcResponse = await this.#options.execute(principal(device), sanitized);
          if (!this.#authorizedDevice(device.id) || this.#stopRequested) { socket.close(1008, 'DEVICE_REVOKED'); return; }
          this.#send(socket, JSON.stringify(result));
        } catch (error) {
          const known = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', '请求无法完成');
          this.#send(socket, JSON.stringify({ id, ok: false, error: { code: known.code, message: known.message } }));
        }
      }).finally(() => { client.pending--; client.pendingBytes -= bytes; });
      void client.queue.catch(() => socket.terminate());
    });
  }
  #send(socket: WebSocket, frame: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Buffer.byteLength(frame) > MAX_MESSAGE || socket.bufferedAmount + Buffer.byteLength(frame) > MAX_MESSAGE) { this.#disconnect(socket, 'RESYNC_REQUIRED'); return; }
    socket.send(frame, (error) => { if (error) socket.terminate(); });
  }
  #disconnect(socket: WebSocket, reason: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.close(1008, reason);
    const timer = setTimeout(() => socket.terminate(), 500);
    timer.unref(); socket.once('close', () => clearTimeout(timer));
  }
  #sweep(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) if (ticket.expiresAtMs <= now) this.#tickets.delete(id);
    for (const [ip, failure] of this.#failures) if (failure.until <= now) this.#failures.delete(ip);
    for (const [socket, client] of this.#clients) if (!this.#authorizedDevice(client.deviceId)) this.#disconnect(socket, 'DEVICE_REVOKED');
  }
}
