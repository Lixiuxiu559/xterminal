import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionHost } from './controller.ts';
import { Store } from '../../storage/src/store.ts';
import type { ShellRuntime, ShellRuntimeOptions } from '../../engines/shell/src/runtime.ts';

async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'xterminal-host-test-'));
  const dbPath = join(path, 'state.sqlite');
  const schema = resolve('docs/architecture/schema.sql');
  const openStore = () => new Store(dbPath, schema, path => new DatabaseSync(path));
  const store = openStore();
  const host = new SessionHost({ dbPath, schemaPath: schema, shell: '/bin/sh', emit: () => {} }, { store,
    createTerminal: (options: ShellRuntimeOptions) => {
      const runtime = {
        runId: options.runId, terminalEpoch: randomUUID(), exited: false,
        async terminate() { runtime.exited = true; options.onExit({ exitCode: 129 }); },
      };
      return runtime as unknown as ShellRuntime;
    },
  });
  const project = host.addProject(path);
  const session = store.createSession({ id: randomUUID(), projectId: project.id, engine: 'shell', title: 'test' });
  await host.handle({ id: randomUUID(), method: 'control.acquire', params: { sessionId: session.id } });
  return { path, host, store, session, openStore };
}
const send = (host: SessionHost, method: string, params: unknown) => {
  const id = (params as { sessionId?: string }).sessionId;
  const lease = host.bootstrap().sessions.find(session => session.id === id)?.control;
  return host.handle({ id: randomUUID(), method, params, ...(lease ? { control: { hostInstanceId: lease.hostInstanceId, generation: lease.generation } } : {}) });
};

test('D11: 退出准备先排空已接收启动并冻结新操作，取消后可继续运行', async () => {
  const f = await fixture();
  try {
    const starting = send(f.host, 'shell.start', { sessionId: f.session.id, cols: 80, rows: 24 });
    const prepared = await f.host.prepareShutdown();
    assert.equal((await starting).ok, true);
    assert.equal(prepared.sessions[0].state, 'running');
    const rejected = await send(f.host, 'shell.start', { sessionId: f.session.id, cols: 80, rows: 24 });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'HOST_CLOSING');
    f.host.cancelShutdown();
    const renamed = await send(f.host, 'session.rename', { sessionId: f.session.id, title: '继续工作', expectedRevision: 1 });
    assert.equal(renamed.ok, true);
    assert.equal(f.host.bootstrap().sessions[0].state, 'running');
    await f.host.close();
    const reopened = f.openStore();
    assert.equal(reopened.lastRun(f.session.id)?.status, 'exited');
    reopened.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});

test('D12/D13: 主动结束的非零码记为exited；保存失败不能成功退出，修复后可重试落盘', async () => {
  const f = await fixture();
  try {
    const started = await send(f.host, 'shell.start', { sessionId: f.session.id, cols: 80, rows: 24 });
    assert.equal(started.ok, true);
    const finish = f.store.finishRun.bind(f.store);
    f.store.finishRun = () => { throw new Error('模拟磁盘写满'); };
    await assert.rejects(f.host.close(), /磁盘/);
    assert.equal(f.host.bootstrap().sessions[0].runId, null);
    assert.equal(f.host.bootstrap().sessions[0].state, 'error');
    assert.equal(f.store.lastRun(f.session.id)?.status, 'starting');
    const blocked = await send(f.host, 'shell.start', { sessionId: f.session.id, cols: 80, rows: 24 });
    assert.equal(blocked.ok, false);
    f.store.finishRun = finish;
    await f.host.close();
    const reopened = f.openStore();
    assert.equal(reopened.lastRun(f.session.id)?.status, 'exited');
    reopened.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});

test('多端Host：显式接管使旧桌面代际立即失效，撤销释放控制且不自动重启任务', async () => {
  const f = await fixture();
  try {
    const old = f.host.bootstrap().sessions[0].control!;
    const first = await send(f.host, 'shell.start', { sessionId: f.session.id, cols: 80, rows: 24 });
    assert.equal(first.ok, true); const runId = f.host.bootstrap().sessions[0].runId!;
    const acquired = await f.host.handle({ id: randomUUID(), method: 'control.acquire', params: { sessionId: f.session.id } }, 'device:phone');
    assert.equal(acquired.ok, true);
    const phone = f.host.bootstrap().sessions[0].control!;
    assert.equal(phone.principalId, 'device:phone'); assert.ok(phone.generation > old.generation);
    const stale = await f.host.handle({ id: randomUUID(), method: 'shell.terminate', params: { sessionId: f.session.id, runId }, control: { hostInstanceId: old.hostInstanceId, generation: old.generation } });
    assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, 'STALE_CONTROL');
    assert.equal(f.host.bootstrap().sessions[0].runId, runId);
    f.host.revokeControl('device:phone');
    assert.equal(f.host.bootstrap().sessions[0].control, null);
    assert.equal(f.host.bootstrap().sessions[0].runId, runId);
    const revoked = await f.host.handle({ id: randomUUID(), method: 'shell.terminate', params: { sessionId: f.session.id, runId }, control: { hostInstanceId: phone.hostInstanceId, generation: phone.generation } }, 'device:phone');
    assert.equal(revoked.ok, false);
    await f.host.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});
