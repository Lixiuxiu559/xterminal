import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTransport, ownLeases } from './browserTransport.ts';
import type { Bootstrap, RpcRequest } from '../../../packages/protocol/src/desktop.ts';

class Socket extends EventTarget {
  readyState = 0; bufferedAmount = 0; sent: RpcRequest[] = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  send(value: string) { this.sent.push(JSON.parse(value) as RpcRequest); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}
function snapshot(): Bootstrap {
  return { hostInstanceId: 'host', principalId: 'device:phone', projects: [], engines: [], sessions: [{ id: 's', projectId: 'p', engine: 'shell', title: 'test', initialCwd: '/', revision: 1, lastSeq: 0, createdAt: '', updatedAt: '', state: 'running', runId: 'r', error: null, control: { principalId: 'device:phone', hostInstanceId: 'host', generation: 3, expiresAtMs: Date.now() + 30_000 } }] };
}
async function fixture(probe: () => Promise<Bootstrap> = async () => snapshot()) {
  const socket = new Socket(); let revoked = false;
  const bridge = new BrowserTransport(snapshot(), { origin: 'https://192.168.1.2:7680', createSocket: () => socket as unknown as WebSocket, probe, onUnauthorized: () => { revoked = true; } });
  const started = bridge.start(); socket.open();
  socket.receive({ id: socket.sent.at(-1)!.id, ok: true, result: snapshot() });
  await started;
  return { bridge, socket, revoked: () => revoked };
}
test('lease cache includes only the authenticated principal', () => {
  const state = snapshot();
  state.sessions.push({ ...state.sessions[0]!, id: 'other', control: { ...state.sessions[0]!.control!, principalId: 'desktop' } });
  assert.deepEqual([...ownLeases(state, 'device:phone').keys()], ['s']);
});
test('read-only calls cannot acquire implicitly; controlled input has only a stamp', async () => {
  const { bridge, socket } = await fixture();
  try {
    const result = bridge.invoke('shell.input', { sessionId: 's', runId: 'r', terminalEpoch: 'e', inputId: 'i', data: 'pwd\r' });
    const request = socket.sent.at(-1)!;
    assert.deepEqual(request.control, { hostInstanceId: 'host', generation: 3 });
    assert.equal('principalId' in request, false);
    socket.receive({ id: request.id, ok: true, result: { written: true } });
    await result;
    const state = snapshot(); state.sessions[0]!.control = null;
    socket.receive({ type: 'catalog.changed', snapshot: state });
    const count = socket.sent.length;
    await assert.rejects(bridge.invoke('shell.input', { sessionId: 's', runId: 'r', terminalEpoch: 'e', inputId: 'i2', data: 'ls\r' }), { code: 'CONTROL_REQUIRED' });
    assert.equal(socket.sent.length, count);
    await assert.rejects(bridge.selectProject(), { code: 'FORBIDDEN' });
    await assert.rejects(bridge.invoke('lan.status', {}), { code: 'FORBIDDEN' });
  } finally { bridge.dispose(); }
});
test('a newer catalog wins over older bootstrap and acquire responses', async () => {
  const { bridge, socket } = await fixture();
  try {
    const restore = bridge.invoke('bootstrap', {}); const restoreId = socket.sent.at(-1)!.id;
    const acquire = bridge.invoke('control.acquire', { sessionId: 's' }); const acquireId = socket.sent.at(-1)!.id;
    const newer = snapshot(); newer.sessions[0]!.control = null;
    socket.receive({ type: 'catalog.changed', snapshot: newer });
    socket.receive({ id: restoreId, ok: true, result: snapshot() });
    socket.receive({ id: acquireId, ok: true, result: snapshot().sessions[0]!.control });
    assert.equal((await restore).sessions[0]!.control, null); await acquire;
    await assert.rejects(bridge.invoke('shell.start', { sessionId: 's', cols: 80, rows: 24 }), { code: 'CONTROL_REQUIRED' });
  } finally { bridge.dispose(); }
});
test('disconnect rejects uncertain writes, does not replay, and revocation ends reconnection', async () => {
  const { bridge, socket, revoked } = await fixture();
  let eventCount = 0;
  bridge.onEvent(event => { if (event.type === 'host.offline') eventCount += 1; });
  const pending = bridge.invoke('shell.input', { sessionId: 's', runId: 'r', terminalEpoch: 'e', inputId: 'i', data: 'command\r' });
  const count = socket.sent.length;
  socket.close(1008, 'DEVICE_REVOKED');
  await assert.rejects(pending, { code: 'RESULT_UNCONFIRMED' });
  assert.equal(socket.sent.length, count); assert.equal(revoked(), true); assert.equal(eventCount, 1);
  await assert.rejects(bridge.invoke('bootstrap', {}), { code: 'DISCONNECTED' });
});
test('request, send buffer, pending queue limits reject before sending', async () => {
  const { bridge, socket } = await fixture();
  try {
    await assert.rejects(bridge.invoke('agent.turn.start', { sessionId: 's', commandId: 'c', text: '中'.repeat(30_000) }), { code: 'PAYLOAD_TOO_LARGE' });
    socket.bufferedAmount = 1024 * 1024;
    await assert.rejects(bridge.invoke('bootstrap', {}), { code: 'SEND_BUFFER_FULL' });
    socket.bufferedAmount = 0;
    const requests = Array.from({ length: 128 }, () => bridge.invoke('engine.models', { engine: 'codex' }).catch(error => error));
    await assert.rejects(bridge.invoke('bootstrap', {}), { code: 'TOO_MANY_REQUESTS' });
    bridge.dispose(); await Promise.all(requests);
  } finally { bridge.dispose(); }
});
test('desktop LAN events never reach the phone view', async () => {
  const { bridge, socket } = await fixture();
  try {
    let count = 0; bridge.onEvent(() => { count += 1; });
    socket.receive({ type: 'lan.changed', state: { pairingCode: 'secret' } });
    assert.equal(count, 0);
  } finally { bridge.dispose(); }
});

test('heartbeat renews only an owned lease and never acquires control', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const { bridge, socket } = await fixture();
  try {
    context.mock.timers.tick(5000);
    const request = socket.sent.at(-1)!;
    assert.equal(request.method, 'control.renew');
    assert.deepEqual(request.control, { hostInstanceId: 'host', generation: 3 });
    assert.equal(socket.sent.some(item => item.method === 'control.acquire'), false);
    socket.receive({ id: request.id, ok: true, result: snapshot().sessions[0]!.control });
  } finally { bridge.dispose(); context.mock.timers.reset(); }
});
test('failed upgrades probe authentication and a 401 ends retries', async () => {
  const { bridge, socket, revoked } = await fixture(async () => { throw Object.assign(new Error('expired'), { code: 'UNAUTHENTICATED' }); });
  socket.close(1006, '');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(revoked(), true);
  await assert.rejects(bridge.invoke('bootstrap', {}), { code: 'DISCONNECTED' });
});
test('oversized inbound frames disconnect with an explicit reason', async () => {
  const { bridge, socket } = await fixture();
  try {
    let reason = ''; bridge.onEvent(event => { if (event.type === 'host.offline') reason = event.message; });
    socket.receive({ type: 'terminal.output', data: 'a'.repeat(1024 * 1024) });
    assert.equal(socket.readyState, 3);
    assert.match(reason, /过大/);
  } finally { bridge.dispose(); }
});

test('reconnection installs listeners before bootstrap and preserves a newer catalog barrier', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets: Socket[] = [];
  const bridge = new BrowserTransport(snapshot(), {
    origin: 'https://192.168.1.2:7680',
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; },
    probe: async () => snapshot(), onUnauthorized: () => { throw new Error('unexpected revocation'); },
  });
  const catalogs: Bootstrap[] = [];
  bridge.onEvent(event => { if (event.type === 'catalog.changed') catalogs.push(event.snapshot); });
  try {
    const started = bridge.start(); const first = sockets[0]!; first.open();
    first.receive({ id: first.sent.at(-1)!.id, ok: true, result: snapshot() }); await started;
    const input = bridge.invoke('shell.input', { sessionId: 's', runId: 'r', terminalEpoch: 'e', inputId: 'once', data: 'echo once\r' });
    first.close(1006);
    await assert.rejects(input, { code: 'RESULT_UNCONFIRMED' });
    await Promise.resolve(); context.mock.timers.tick(1000);
    assert.equal(sockets.length, 2);
    const second = sockets[1]!; second.open();
    const restoring = second.sent.at(-1)!; assert.equal(restoring.method, 'bootstrap');
    const newer = snapshot(); newer.sessions[0]!.control = null;
    second.receive({ type: 'catalog.changed', snapshot: newer });
    assert.equal(catalogs.at(-1)!.sessions[0]!.control, null);
    second.receive({ id: restoring.id, ok: true, result: snapshot() });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(catalogs.at(-1)!.sessions[0]!.control, null);
    assert.equal(second.sent.some(request => request.method === 'shell.input'), false);
    await assert.rejects(bridge.invoke('shell.start', { sessionId: 's', cols: 80, rows: 24 }), { code: 'CONTROL_REQUIRED' });
  } finally { bridge.dispose(); context.mock.timers.reset(); }
});
test('late create and renew responses cannot restore a revoked lease', async () => {
  const { bridge, socket } = await fixture();
  try {
    const renew = bridge.invoke('control.renew', { sessionId: 's' }); const renewId = socket.sent.at(-1)!.id;
    const create = bridge.invoke('session.create', { projectId: 'p', engine: 'shell', title: 'new', commandId: 'new' }); const createId = socket.sent.at(-1)!.id;
    const newer = snapshot(); newer.sessions[0]!.control = null;
    socket.receive({ type: 'catalog.changed', snapshot: newer });
    socket.receive({ id: renewId, ok: true, result: snapshot().sessions[0]!.control });
    socket.receive({ id: createId, ok: true, result: { ...snapshot().sessions[0]!, id: 'new' } });
    await renew; await create;
    for (const sessionId of ['s', 'new']) await assert.rejects(bridge.invoke('shell.start', { sessionId, cols: 80, rows: 24 }), { code: 'CONTROL_REQUIRED' });
  } finally { bridge.dispose(); }
});

for (const mode of ['http', 'https']) test(mode + ': websocket preserves page scheme and origin', async () => {
 const socket = new Socket(); let url = '';
 const bridge = new BrowserTransport(snapshot(), { origin: mode + '://192.168.1.2:7680', createSocket: value => { url = value; return socket as unknown as WebSocket; }, onUnauthorized: () => {}, probe: async () => snapshot() });
 try {
 const started = bridge.start(); socket.open(); socket.receive({id:socket.sent.at(-1)!.id,ok:true,result:snapshot()}); await started;
 assert.equal(url, (mode === 'http' ? 'ws' : 'wss') + '://192.168.1.2:7680/api/v1/stream');
 } finally {bridge.dispose();}
});
