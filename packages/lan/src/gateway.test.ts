import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { checkServerIdentity } from 'node:tls';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { WebSocket } from 'ws';
import { LanGateway, isPrivateIPv4 } from './gateway.ts';
import type { PairingRequest } from './types.ts';

interface Response { status: number; body: any; headers: IncomingHttpHeaders }
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'xterminal-lan-'));
  const dataPath = join(directory, 'data'); const uiPath = join(directory, 'ui');
  await mkdir(uiPath); await writeFile(join(uiPath, 'index.html'), '<!doctype html><title>Pair device</title>');
  await writeFile(join(directory, 'private.txt'), 'must-not-serve');
  await symlink(join(directory, 'private.txt'), join(uiPath, 'escape.txt'));
  let now = Date.now();
  const requests: PairingRequest[] = []; const revoked: string[] = []; const executions: Array<{ principalId: string; request: unknown }> = [];
  const gateway = new LanGateway({ dataPath, uiPath, bindAddress: '127.0.0.1',
    execute: async (principalId, request) => { executions.push({ principalId, request }); return { id: (request as { id: string }).id, ok: true, result: { accepted: true } }; },
    bootstrap: (principalId) => ({ principalId, projects: [], sessions: [] }),
    onPairingRequest: (request) => requests.push(request), onDeviceRevoked: (id) => revoked.push(id),
  }, { allowLoopback: true, now: () => now });
  const started = await gateway.start(); const ca = await readFile(started.caCertificatePath);
  const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string | null; host?: string; site?: string; trust?: boolean; verifyBindAddress?: boolean } = {}): Promise<Response> => new Promise((resolveResponse, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = https.request(new URL(path, started.address.origin), {
      ca: options.trust === false ? undefined : ca, method: options.method ?? 'GET', agent: false,
      ...(options.verifyBindAddress ? { checkServerIdentity: (_host: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity('127.0.0.1', certificate) } : {}),
      headers: { ...(options.origin !== null ? { Origin: options.origin ?? started.address.origin } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.host ? { Host: options.host } : {}), ...(options.site ? { 'Sec-Fetch-Site': options.site } : {}) },
    }, (response) => {
      let result = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { result += chunk; });
      response.once('end', () => {
        let parsed: unknown = result;
        try { parsed = JSON.parse(result); } catch { /* static HTML */ }
        resolveResponse({ status: response.statusCode!, body: parsed, headers: response.headers });
      });
    });
    req.once('error', reject); if (body) req.write(body); req.end();
  });
  const cookieFrom = (response: Response, name: string): string => response.headers['set-cookie']!.find((cookie) => cookie.startsWith(`${name}=`))!.split(';')[0]!;
  async function pair() {
    const code = gateway.rotatePairingCode();
    const submitted = await request('/api/v1/pairing/requests', { method: 'POST', body: { code: code.code, deviceName: '测试手机' } });
    assert.equal(submitted.status, 202);
    const applicant = cookieFrom(submitted, '__Host-xterminal-pairing');
    const ticket = submitted.body.ticket as string;
    await gateway.approvePairing(ticket);
    const claimed = await request(`/api/v1/pairing/requests/${ticket}`, { cookie: applicant });
    assert.equal(claimed.status, 200);
    return { ticket, applicant, cookie: cookieFrom(claimed, '__Host-xterminal-device'), claimed };
  }
  const connect = (cookie?: string, origin = started.address.origin): Promise<WebSocket> => new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(started.address.origin.replace('https:', 'wss:') + '/api/v1/stream', { ca, origin, headers: cookie ? { Cookie: cookie } : {} });
    socket.once('open', () => resolveSocket(socket)); socket.once('error', reject);
  });
  return { gateway, directory, dataPath, started, requests, revoked, executions, request, cookieFrom, pair, connect,
    advance: (ms: number) => { now += ms; },
    cleanup: async () => { await gateway.stop(); await rm(directory, { recursive: true, force: true }); } };
}
const message = (socket: WebSocket): Promise<any> => new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()))));
const closed = (socket: WebSocket): Promise<{ code: number; reason: string }> => new Promise((resolve) => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));

test('生产仅接受 RFC1918 IPv4，构造不会监听', () => {
  assert.equal(isPrivateIPv4('10.1.2.3'), true); assert.equal(isPrivateIPv4('172.31.2.3'), true); assert.equal(isPrivateIPv4('192.168.1.2'), true);
  for (const address of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.32.1.1', '::1', '192.168.01.2']) {
    assert.throws(() => new LanGateway({ bindAddress: address } as any));
  }
  const gateway = new LanGateway({ bindAddress: '192.168.1.2' } as any);
  assert.equal(gateway.address, null);
});

test('真实 HTTPS 信任链/IP SAN、文件权限、静态入口、Host/Origin/路径边界', async () => {
  const ctx = await setup();
  try {
    const cert = new X509Certificate(await readFile(join(ctx.dataPath, 'certificates', 'server-127.0.0.1.crt')));
    assert.equal(cert.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal((await stat(ctx.dataPath)).mode & 0o777, 0o700);
    assert.equal((await stat(join(ctx.dataPath, 'certificates', 'ca.key'))).mode & 0o777, 0o600);
    await assert.rejects(ctx.request('/healthz', { trust: false }));
    await assert.rejects(ctx.request('/healthz', { host: 'attacker.invalid' }));
    assert.equal((await ctx.request('/healthz')).status, 200);
    assert.equal((await ctx.request('/', { origin: null })).status, 200);
    const unauthorized = await ctx.request('/api/v1/bootstrap');
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.error.code, 'UNAUTHENTICATED');
    assert.equal((await ctx.request('/', { origin: 'null' })).status, 403);
    assert.equal((await ctx.request('/', { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await ctx.request('/', { host: 'attacker.invalid', verifyBindAddress: true })).status, 403);
    assert.equal((await ctx.request('/', { host: `user@127.0.0.1:${ctx.started.address.port}`, verifyBindAddress: true })).status, 403);
    assert.equal((await ctx.request('/', { origin: null, site: 'cross-site' })).status, 403);
    assert.equal((await ctx.request('/%zz')).status, 400);
    assert.equal((await ctx.request('/escape.txt')).status, 404);
    assert.equal((await ctx.request('/api/v1/pairing/requests', { method: 'POST', origin: null, body: {} })).status, 403);
  } finally { await ctx.cleanup(); }
});

test('配对需要本地批准和原申请方secret，单次领取，磁盘只保存token hash', async () => {
  const ctx = await setup();
  try {
    const code = ctx.started.pairingCode;
    const submitted = await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: code.code, deviceName: '我的手机' } });
    assert.equal(submitted.status, 202); assert.equal(ctx.requests.length, 1);
    const ticket = submitted.body.ticket;
    const applicant = ctx.cookieFrom(submitted, '__Host-xterminal-pairing');
    assert.match(submitted.headers['set-cookie']![0]!, /Secure; HttpOnly; SameSite=Strict/);
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${ticket}`, { cookie: applicant })).body.status, 'pending');
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${ticket}`)).status, 403);
    await ctx.gateway.approvePairing(ticket);
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${ticket}`, { cookie: '__Host-xterminal-pairing=stolen' })).status, 403);
    const claimed = await ctx.request(`/api/v1/pairing/requests/${ticket}`, { cookie: applicant });
    assert.equal(claimed.status, 200);
    const cookie = ctx.cookieFrom(claimed, '__Host-xterminal-device');
    const bootstrap = await ctx.request('/api/v1/bootstrap', { cookie });
    assert.equal(bootstrap.status, 200); assert.equal(bootstrap.body.principalId, claimed.body.principalId);
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${ticket}`, { cookie: applicant })).status, 410);
    const file = await readFile(join(ctx.dataPath, 'devices.json'), 'utf8');
    assert.equal(file.includes(cookie.split('=')[1]!), false); assert.equal(file.includes(applicant.split('=')[1]!), false); assert.equal(file.includes(code.code), false);
    const devices = await ctx.gateway.listDevices(); assert.equal(devices.length, 1); assert.equal('tokenHash' in devices[0]!, false);
    assert.equal((await stat(join(ctx.dataPath, 'devices.json'))).mode & 0o777, 0o600);
  } finally { await ctx.cleanup(); }
});

test('配对码与票据过期、拒绝及每IP五次失败限速', async () => {
  const ctx = await setup();
  try {
    const expiredCode = ctx.started.pairingCode.code;
    ctx.advance(120001);
    assert.equal((await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: expiredCode, deviceName: 'expired' } })).status, 403);
    const fresh = ctx.gateway.rotatePairingCode();
    const submitted = await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: fresh.code, deviceName: 'reject' } });
    ctx.gateway.rejectPairing(submitted.body.ticket);
    const applicant = ctx.cookieFrom(submitted, '__Host-xterminal-pairing');
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${submitted.body.ticket}`, { cookie: applicant })).body.status, 'rejected');
    await assert.rejects(ctx.gateway.approvePairing(submitted.body.ticket));
    ctx.advance(120001);
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${submitted.body.ticket}`, { cookie: applicant })).status, 410);
    const approvedCode = ctx.gateway.rotatePairingCode();
    const approved = await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: approvedCode.code, deviceName: 'approve-then-expire' } });
    await ctx.gateway.approvePairing(approved.body.ticket);
    ctx.advance(120001);
    assert.equal((await ctx.request(`/api/v1/pairing/requests/${approved.body.ticket}`, { cookie: ctx.cookieFrom(approved, '__Host-xterminal-pairing') })).status, 410);
    assert.equal((await ctx.gateway.listDevices()).length, 0);
    for (let i = 0; i < 4; i++) assert.equal((await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: 'bad', deviceName: 'invalid' } })).status, 403);
    assert.equal((await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: 'bad', deviceName: 'invalid' } })).status, 429);
  } finally { await ctx.cleanup(); }
});

test('并发猜码仍仅五次进入校验，超大HTTP请求明确413', async () => {
  const ctx = await setup();
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: 'bad', deviceName: 'parallel' } })));
    assert.equal(responses.filter((response) => response.status === 403).length, 5);
    assert.equal(responses.filter((response) => response.status === 429).length, 15);
    ctx.advance(10 * 60000 + 1);
    assert.equal((await ctx.request('/api/v1/pairing/requests', { method: 'POST', body: { code: 'bad', deviceName: 'x'.repeat(70000) } })).status, 413);
    assert.equal((await ctx.request('/healthz')).status, 200);
  } finally { await ctx.cleanup(); }
});

test('WSS cookie认证、Origin白名单、手机方法白名单、广播与撤销', async () => {
  const ctx = await setup();
  try {
    await assert.rejects(ctx.connect());
    const paired = await ctx.pair();
    await assert.rejects(ctx.connect(paired.cookie, 'https://evil.invalid'));
    const socket = await ctx.connect(paired.cookie);
    const forbidden = message(socket);
    socket.send(JSON.stringify({ id: 'forbidden', method: 'project.add', params: { path: '/tmp' } }));
    assert.equal((await forbidden).error.code, 'FORBIDDEN'); assert.equal(ctx.executions.length, 0);
    const accepted = message(socket);
    const control = { hostInstanceId: 'host-test', generation: 7 };
    socket.send(JSON.stringify({ id: 'ok', method: 'session.rename', principalId: 'attacker', actorId: 'attacker', control, params: { sessionId: 's', title: 'test' } }));
    assert.equal((await accepted).ok, true);
    assert.equal(ctx.executions[0]!.principalId, paired.claimed.body.principalId);
    assert.equal('principalId' in (ctx.executions[0]!.request as any), false);
    assert.equal('actorId' in (ctx.executions[0]!.request as any), false);
    assert.deepEqual((ctx.executions[0]!.request as any).control, control);
    for (const method of ['control.renew', 'engine.models']) {
      const response = message(socket); socket.send(JSON.stringify({ id: method, method, params: {}, control }));
      assert.equal((await response).ok, true);
    }
    const event = message(socket); ctx.gateway.broadcast({ type: 'host.offline', message: 'test event' });
    assert.equal((await event).message, 'test event');
    const disconnect = closed(socket);
    await ctx.gateway.revokeDevice(paired.claimed.body.device.id);
    assert.equal((await disconnect).reason, 'DEVICE_REVOKED');
    assert.deepEqual(ctx.revoked, [paired.claimed.body.principalId]);
    const denied = await ctx.request('/api/v1/bootstrap', { cookie: paired.cookie });
    assert.equal(denied.status, 401); assert.equal(denied.body.error.code, 'DEVICE_REVOKED');
    await assert.rejects(ctx.connect(paired.cookie));
  } finally { await ctx.cleanup(); }
});

test('catalog为每个连接覆写设备身份，本机lan.changed绝不进入手机事件流', async () => {
  const ctx = await setup();
  try {
    const first = await ctx.pair(); const second = await ctx.pair();
    const firstSocket = await ctx.connect(first.cookie); const secondSocket = await ctx.connect(second.cookie);
    const firstEvent = message(firstSocket); const secondEvent = message(secondSocket);
    ctx.gateway.broadcast({ type: 'lan.changed', status: { code: 'local-only-test-code' } } as any);
    const catalog = { type: 'catalog.changed' as const, snapshot: { hostInstanceId: 'host', principalId: 'desktop', projects: [], sessions: [], engines: [] } };
    ctx.gateway.broadcast(catalog);
    const firstResult = await firstEvent; const secondResult = await secondEvent;
    assert.equal(firstResult.type, 'catalog.changed'); assert.equal(secondResult.type, 'catalog.changed');
    assert.equal(firstResult.snapshot.principalId, first.claimed.body.principalId);
    assert.equal(secondResult.snapshot.principalId, second.claimed.body.principalId);
    assert.equal(catalog.snapshot.principalId, 'desktop');
    firstSocket.close(); secondSocket.close();
  } finally { await ctx.cleanup(); }
});

test('WSS升级鉴权拒绝返回稳定JSON错误码', async () => {
  const ctx = await setup();
  const ca = await readFile(ctx.started.caCertificatePath);
  const rejectedUpgrade = (cookie?: string): Promise<{ status: number; body: any; code: string | undefined }> => new Promise((resolveRejected, reject) => {
    const client = new WebSocket(ctx.started.address.origin.replace('https:', 'wss:') + '/api/v1/stream', { ca, origin: ctx.started.address.origin, headers: cookie ? { Cookie: cookie } : {} });
    client.once('error', reject);
    client.once('unexpected-response', (_request, response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk) => { body += chunk; });
      response.once('end', () => {
        resolveRejected({ status: response.statusCode!, body: JSON.parse(body), code: response.headers['x-xterminal-error'] as string | undefined });
        client.terminate();
      });
    });
  });
  try {
    const missing = await rejectedUpgrade();
    assert.equal(missing.status, 401); assert.equal(missing.body.error.code, 'UNAUTHENTICATED'); assert.equal(missing.code, 'UNAUTHENTICATED');
    const paired = await ctx.pair(); await ctx.gateway.revokeDevice(paired.claimed.body.device.id);
    const revoked = await rejectedUpgrade(paired.cookie);
    assert.equal(revoked.status, 401); assert.equal(revoked.body.error.code, 'DEVICE_REVOKED');
  } finally { await ctx.cleanup(); }
});

test('设备七天过期、命令限制及大事件要求重同步', async () => {
  const ctx = await setup();
  try {
    const paired = await ctx.pair(); const socket = await ctx.connect(paired.cookie);
    const oversized = message(socket);
    socket.send(JSON.stringify({ id: 'large', method: 'session.rename', params: { title: 'x'.repeat(66000) } }));
    assert.equal((await oversized).error.code, 'PAYLOAD_TOO_LARGE'); assert.equal(ctx.executions.length, 0);
    const huge = await ctx.connect(paired.cookie); const rejectedMessage = closed(huge);
    huge.send('x'.repeat(1024 * 1024 + 1));
    assert.ok([1006, 1009].includes((await rejectedMessage).code));
    const resync = closed(socket);
    ctx.gateway.broadcast({ type: 'host.offline', message: 'x'.repeat(1024 * 1024) });
    assert.equal((await resync).reason, 'RESYNC_REQUIRED');
    const expiring = await ctx.connect(paired.cookie); const disconnected = closed(expiring);
    ctx.advance(7 * 86400000 + 1);
    assert.equal((await ctx.request('/api/v1/bootstrap', { cookie: paired.cookie })).status, 401);
    ctx.gateway.broadcast({ type: 'host.offline', message: 'expired' });
    assert.equal((await disconnected).reason, 'DEVICE_REVOKED');
    assert.deepEqual(ctx.revoked, [paired.claimed.body.principalId]);
  } finally { await ctx.cleanup(); }
});

test('关闭访问撤销已有授权，重新开启不复活旧Cookie', async () => {
  const ctx = await setup();
  try {
    const paired = await ctx.pair();
    await ctx.gateway.stop();
    assert.equal(ctx.gateway.address, null);
    assert.deepEqual(ctx.revoked, [paired.claimed.body.principalId]);
    const devices = await ctx.gateway.listDevices(); assert.notEqual(devices[0]!.revokedAtMs, null);
    const restarted = await ctx.gateway.start();
    const ca = await readFile(restarted.caCertificatePath);
    const status = await new Promise<number>((resolveStatus, reject) => {
      const request = https.get(restarted.address.origin + '/api/v1/bootstrap', { ca, agent: false, headers: { Cookie: paired.cookie } }, (response) => { response.resume(); resolveStatus(response.statusCode!); });
      request.once('error', reject);
    });
    assert.equal(status, 401);
  } finally { await ctx.cleanup(); }
});
