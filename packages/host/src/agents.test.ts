import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../storage/src/store.ts';
import { SessionHost } from './controller.ts';
import type { AgentRuntime, AgentRuntimeOptions, AgentEngineEvent, AgentAnswer } from '../../protocol/src/agent.ts';
import type { AppSession, RpcResponse } from '../../protocol/src/desktop.ts';
class FakeAgent implements AgentRuntime {
  readonly engine = 'codex' as const;
  readonly options: AgentRuntimeOptions;
  runId: string | null = null; starts = 0; answers = 0; stops = 0;
  constructor(options: AgentRuntimeOptions) { this.options = options; }
  async startTurn(input: {runId:string;text:string}) { this.runId = input.runId; this.starts++; this.emit({ type: 'context', runId: input.runId, nativeContextId: this.options.nativeContextId ?? 'native-test-context' }); }
  async respond(id: string, _answer: AgentAnswer) { this.answers++; this.emit({ type: 'interaction.resolved', runId: this.runId!, interactionId: id }); }
  async interrupt(_runId: string) { this.stops++; }
  async close() { this.emit({ type: 'process.exited', runId: this.runId, error: 'closed' }); }
  emit(event: AgentEngineEvent) { this.options.onEvent(event); }
}
async function fixture() {
  const path = mkdtempSync(join(tmpdir(), 'xterminal-agents-'));
  const dbPath = join(path, 'state.sqlite'); const schemaPath = resolve('docs/architecture/schema.sql');
  const runtimes: FakeAgent[] = [];
  const openStore = () => new Store(dbPath, schemaPath, path => new DatabaseSync(path));
  const store = openStore();
  const services = { agents: { createRuntime: (_engine: unknown, options: AgentRuntimeOptions) => { const runtime = new FakeAgent(options); runtimes.push(runtime); return runtime; }, detect: async () => [{ engine: 'codex' as const, available: true, version: 'fixture', reason: null }] } };
  const openHost = (store: Store) => new SessionHost({ dbPath, schemaPath, shell: '/bin/sh', emit: () => {} }, { store, ...services });
  const host = openHost(store); await host.ready();
  const project = host.addProject(path);
  const session = store.createSession({ id: randomUUID(), projectId: project.id, engine: 'codex', title: 'Agent test' });
  return { path, host, store, session, runtimes, project, openStore, openHost };
}
const send = async (host: SessionHost, method: string, params: unknown) => {
  const id = (params as { sessionId?: string }).sessionId;
  let lease = host.bootstrap().sessions.find(session => session.id === id)?.control;
  if (id && !lease) {
    await host.handle({ id: randomUUID(), method: 'control.acquire', params: { sessionId: id } });
    lease = host.bootstrap().sessions.find(session => session.id === id)?.control;
  }
  return host.handle({ id: randomUUID(), method, params, ...(lease ? { control: { hostInstanceId: lease.hostInstanceId, generation: lease.generation } } : {}) });
};
function result<T>(response: RpcResponse): T { if (!response.ok) throw new Error(response.error.code + ': ' + response.error.message); return response.result as T; }

test('A01/A05: 同目录 Agent 锁跨会话生效，不同目录独立；停止受理不等于完成', async () => {
  const f = await fixture();
  try {
    const second = f.store.createSession({ id: randomUUID(), projectId: f.project.id, engine: 'codex', title: 'Second' });
    const otherPath = join(f.path, 'other'); mkdirSync(otherPath); const other = f.host.addProject(otherPath);
    const third = f.store.createSession({ id: randomUUID(), projectId: other.id, engine: 'codex', title: 'Third' });
    const first = result<AppSession>(await send(f.host, 'agent.turn.start', { sessionId: f.session.id, text: 'first', commandId: randomUUID() }));
    const blocked = await send(f.host, 'agent.turn.start', { sessionId: second.id, text: 'second', commandId: randomUUID() });
    assert.equal(blocked.ok, false); if (!blocked.ok) assert.equal(blocked.error.code, 'PROJECT_BUSY');
    assert.equal((await send(f.host, 'agent.turn.start', { sessionId: third.id, text: 'third', commandId: randomUUID() })).ok, true);
    const stop = result<AppSession>(await send(f.host, 'agent.turn.stop', { sessionId: f.session.id, runId: first.runId }));
    assert.equal(stop.state, 'stopping'); assert.equal(stop.runId, first.runId);
    f.runtimes[0].emit({ type: 'turn.completed', runId: first.runId!, outcome: 'interrupted' });
    assert.equal((await send(f.host, 'agent.turn.start', { sessionId: second.id, text: 'second', commandId: randomUUID() })).ok, true);
    await f.host.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});

test('A02/A03/A07: 相同发送ID只启动一次，最终全文覆写且拒绝晚到delta；重启历史和明确上下文保留', async () => {
  const f = await fixture();
  try {
    const params = { sessionId: f.session.id, text: 'hello', commandId: randomUUID() };
    const started = result<AppSession>(await send(f.host, 'agent.turn.start', params));
    assert.equal((await send(f.host, 'agent.turn.start', params)).ok, true);
    assert.equal(f.runtimes[0].starts, 1);
    const conflict = await send(f.host, 'agent.turn.start', { ...params, text: 'different' });
    assert.equal(conflict.ok, false); if (!conflict.ok) assert.equal(conflict.error.code, 'COMMAND_ID_REUSED');
    const runtime = f.runtimes[0]; const runId = started.runId!;
    runtime.emit({ type: 'message.delta', runId, messageId: 'm', text: 'partial' });
    runtime.emit({ type: 'message.completed', runId, messageId: 'm', text: 'canonical final' });
    runtime.emit({ type: 'message.delta', runId, messageId: 'm', text: 'must not append' });
    runtime.emit({ type: 'turn.completed', runId, outcome: 'completed' });
    assert.equal(f.store.listAgentMessages(f.session.id).length, 2);
    assert.equal(f.store.listAgentMessages(f.session.id)[1].text, 'canonical final');
    assert.equal(f.host.bootstrap().sessions[0].state, 'idle');
    await f.host.close();
    const store = f.openStore(); const host = f.openHost(store); await host.ready();
    const snapshot = result<{ messages: Array<{text:string}> }>(await send(host, 'agent.snapshot', { sessionId: f.session.id }));
    assert.deepEqual(snapshot.messages.map(m => m.text), ['hello', 'canonical final']);
    await send(host, 'agent.turn.start', { sessionId: f.session.id, text: 'continue', commandId: randomUUID() });
    assert.equal(f.runtimes.at(-1)!.options.nativeContextId, 'native-test-context');
    await host.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});

test('A04: 权限只回答当前run的一次挂起请求，旧卡片与错误run拒绝', async () => {
  const f = await fixture();
  try {
    const started = result<AppSession>(await send(f.host, 'agent.turn.start', { sessionId: f.session.id, text: 'go', commandId: randomUUID() }));
    const runtime = f.runtimes[0]; const runId = started.runId!;
    runtime.emit({ type: 'interaction', interaction: { id: 'approval', runId, kind: 'permission', title: 'Permission', detail: 'test', actions: ['allow-once', 'deny', 'cancel-turn'] } });
    assert.equal(f.host.bootstrap().sessions[0].state, 'waiting');
    const p = { sessionId: f.session.id, runId, interactionId: 'approval', answer: { action: 'deny' } };
    assert.equal((await send(f.host, 'agent.respond', { ...p, runId: 'stale' })).ok, false);
    assert.equal((await send(f.host, 'agent.respond', p)).ok, true);
    assert.equal((await send(f.host, 'agent.respond', p)).ok, false);
    assert.equal(runtime.answers, 1);
    assert.equal(f.host.bootstrap().sessions[0].state, 'running');
    await f.host.close();
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});

test('C04: 未确认回执恢复不重发；明确新命令可取得项目锁，引擎异常退出释放锁', async () => {
  const f = await fixture();
  try {
    // Persist the exact crash boundary without fabricating a model result.
    const commandId = randomUUID(), runId = randomUUID(), text = 'unconfirmed';
    f.store.acceptAgentTurn({ sessionId: f.session.id, runId, commandId, text, hostInstanceId: f.host.instanceId });
    f.store.markDispatched(f.session.id, commandId);
    await f.host.close();
    const reopenedStore = f.openStore(); const host = f.openHost(reopenedStore); await host.ready();
    try {
      assert.equal(host.bootstrap().sessions[0].state, 'interrupted');
      assert.equal(host.activeCount(), 0);
      const replay = await send(host, 'agent.turn.start', { sessionId: f.session.id, text, commandId });
      assert.equal(replay.ok, false); if (!replay.ok) assert.equal(replay.error.code, 'COMMAND_OUTCOME_UNKNOWN');
      assert.equal(f.runtimes.length, 0, 'replay must not create any engine');
      const started = result<AppSession>(await send(host, 'agent.turn.start', { sessionId: f.session.id, text: 'explicit new request', commandId: randomUUID() }));
      assert.equal(f.runtimes.length, 1);
      f.runtimes[0].emit({ type: 'process.exited', runId: started.runId, error: 'unexpected engine exit' });
      assert.equal(host.activeCount(), 0);
      assert.equal(host.bootstrap().sessions[0].state, 'interrupted');
      const next = await send(host, 'agent.turn.start', { sessionId: f.session.id, text: 'after engine exit', commandId: randomUUID() });
      assert.equal(next.ok, true);
      assert.equal(f.runtimes.length, 2, 'new explicit request creates a new engine after releasing old project lock');
      assert.equal(reopenedStore.listAgentMessages(f.session.id).filter(m => m.text === text).length, 1);
    } finally { await host.close(); }
  } finally { rmSync(f.path, { recursive: true, force: true }); }
});
