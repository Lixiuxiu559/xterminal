import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import httpClient from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { SessionHost } from '../../host/src/controller.ts';
import { Store } from '../../storage/src/store.ts';
import { LanGateway } from './gateway.ts';
import type { AppSession, RpcResponse } from '../../protocol/src/desktop.ts';
import type { LanState } from '../../protocol/src/lan.ts';
import type { ControlLease } from '../../protocol/src/index.ts';
import type { ShellRuntime } from '../../engines/shell/src/runtime.ts';

for (const mode of ['http', 'https'] as const) test(mode + ': Host/SQLite pairing, control and revocation preserve local tasks', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xterminal-lan-host-'));
  const dbPath = join(directory, 'state.sqlite'); const schemaPath = resolve('docs/architecture/schema.sql');
  const store = new Store(dbPath, schemaPath, path => new DatabaseSync(path));
  let terminated = 0;
  const host = new SessionHost({ dbPath, schemaPath, shell: '/bin/sh', uiPath: resolve('dist/ui'), emit: () => {} }, {
    store, agents: { detect: async () => [] },
    lan: { interfaces: () => [{ address: '127.0.0.1', name: 'test-only' }], createGateway: options => new LanGateway(options, { allowLoopback: true }) },
    createTerminal: options => {
      const runtime = { runId: options.runId, terminalEpoch: randomUUID(), exited: false,
        async terminate() { terminated++; runtime.exited = true; options.onExit({ exitCode: 0 }); } };
      return runtime as unknown as ShellRuntime;
    },
  });
  let socket: WebSocket | undefined;
  const local = async (method: string, params: unknown, control?: ControlLease): Promise<unknown> => {
    const result = await host.handle({ id: randomUUID(), method, params, ...(control ? { control: { hostInstanceId: control.hostInstanceId, generation: control.generation } } : {}) });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.result;
  };
  try {
    await host.ready();
    const project = host.addProject(directory);
    const session = await local('session.create', { projectId: project.id, engine: 'shell', title: '跨端测试', commandId: randomUUID() }) as AppSession;
    await local('shell.start', { sessionId: session.id, cols: 80, rows: 24 }, session.control!);
    const denied = await host.handle({ id: 'deny', method: 'lan.enable', params: { address: '127.0.0.1' } }, 'device:forged');
    assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, 'FORBIDDEN');
    const enabled = await local('lan.enable', { address: '127.0.0.1', mode }) as LanState;
    const certificate = host.publicCertificatePath(); const ca = certificate ? await readFile(certificate) : undefined; if(mode === 'http') assert.equal(certificate,null);
    const http = (path: string, method = 'GET', body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookies: string[] }> => new Promise((resolveResponse, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const request = (mode === 'http' ? httpClient : https).request(new URL(path, enabled.origin!), { ca, method, agent: false, headers: { Origin: enabled.origin!, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, response => {
        let content = ''; response.setEncoding('utf8'); response.on('data', chunk => { content += chunk; });
        response.on('end', () => resolveResponse({ status: response.statusCode!, body: JSON.parse(content), cookies: response.headers['set-cookie'] ?? [] }));
      }); request.once('error', reject); request.end(data);
    });
    const submitted = await http('/api/v1/pairing/requests', 'POST', { code: enabled.pairingCode, deviceName: '测试手机' });
    assert.equal(submitted.status, 202);
    await local('lan.approve', { ticket: submitted.body.ticket });
    const claimed = await http(`/api/v1/pairing/requests/${submitted.body.ticket}`, 'GET', undefined, submitted.cookies[0]!.split(';')[0]);
    const cookie = claimed.cookies.find(value => value.startsWith(mode === 'http' ? 'xterminal-http-device=' : '__Host-xterminal-device='))!.split(';')[0]!;
    const principal = claimed.body.principalId;
    const bootstrap = await http('/api/v1/bootstrap', 'GET', undefined, cookie);
    assert.equal(bootstrap.body.principalId, principal); assert.equal(bootstrap.body.sessions[0].state, 'running');
    assert.equal(store.listDevices().length, 1); assert.equal('tokenHash' in claimed.body.device, false);
    socket = new WebSocket(enabled.origin!.replace(/^http/, 'ws') + '/api/v1/stream', { ca, origin: enabled.origin!, headers: { Cookie: cookie } });
    await new Promise<void>((resolveOpen, reject) => { socket!.once('open', resolveOpen); socket!.once('error', reject); });
    const frames: any[] = []; socket.on('message', data => { frames.push(JSON.parse(data.toString())); });
    const rpc = (method: string, params: unknown, control?: ControlLease): Promise<RpcResponse> => new Promise((resolveResponse, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('RPC timeout')); }, 3000);
      const receive = (data: Buffer) => { const response = JSON.parse(data.toString()); if (response.id === id) { clearTimeout(timer); socket!.off('message', receive); resolveResponse(response); } };
      socket!.on('message', receive); socket!.send(JSON.stringify({ id, method, params, ...(control ? { control: { hostInstanceId: control.hostInstanceId, generation: control.generation } } : {}) }));
    });
    const acquired = await rpc('control.acquire', { sessionId: session.id }); assert.equal(acquired.ok, true);
    const lease = acquired.ok ? acquired.result as ControlLease : null; assert.equal(lease?.principalId, principal);
    assert.ok(frames.some(frame => frame.type === 'catalog.changed' && frame.snapshot.principalId === principal));
    await assert.rejects(local('shell.terminate', { sessionId: session.id, runId: host.bootstrap().sessions[0]!.runId }, session.control!), { code: 'STALE_CONTROL' });
    const renewed = await rpc('control.renew', { sessionId: session.id }, lease!); assert.equal(renewed.ok, true);
    const forbidden = await rpc('lan.status', {}); assert.equal(forbidden.ok, false);
    const closed = new Promise<void>(resolveClose => socket!.once('close', () => resolveClose()));
    await local('lan.revoke', { deviceId: claimed.body.device.id }); await closed;
    assert.equal(host.bootstrap().sessions[0]!.control, null); assert.equal(host.bootstrap().sessions[0]!.state, 'running'); assert.equal(terminated, 0);
    assert.equal((await http('/api/v1/bootstrap', 'GET', undefined, cookie)).status, 401);
    assert.ok(store.listDevices()[0]!.revokedAtMs !== null);
    await local('lan.disable', {});
  } finally { socket?.terminate(); await host.close(); await rm(directory, { recursive: true, force: true }); }
  assert.equal(terminated, 1);
});
