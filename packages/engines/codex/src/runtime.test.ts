import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentEngineEvent } from '../../../protocol/src/agent.ts';
import { CodexRuntime, detectCodex } from './runtime.ts';

const fixture = fileURLToPath(new URL('./fixture.mjs', import.meta.url));
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待 fake app-server 事件超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(nativeContextId: string | null = null) {
  const events: AgentEngineEvent[] = [];
  let child: ChildProcessWithoutNullStreams;
  let submitted = false;
  const runtime = new CodexRuntime({ cwd: process.cwd(), nativeContextId, onEvent: (event) => events.push(event) }, {
    spawn: () => {
      child = spawn(process.execPath, [fixture], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes('"delta":"initial"')) submitted = true; });
      return child;
    },
    rpcTimeoutMs: 1500,
  });
  return { runtime, events, exited: () => child?.exitCode !== null, submitted: () => submitted };
}

test('分片初始化、原生审批 ID、早到 delta、最终替换和隔离旧 turn', async () => {
  const { runtime, events, exited } = setup();
  try {
    await runtime.startTurn({ runId: 'run1', text: 'approval' });
    assert.ok(!events.some((event) => event.type === 'turn.completed'));
    await until(() => events.some((event) => event.type === 'interaction'));
    const interaction = events.find((event) => event.type === 'interaction');
    assert.equal(interaction?.type, 'interaction');
    if (interaction?.type !== 'interaction') throw new Error('missing interaction');
    await runtime.respond(interaction.interaction.id, { action: 'allow-once' });
    await assert.rejects(runtime.respond(interaction.interaction.id, { action: 'allow-once' }));
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.deepEqual(events.filter((event) => event.type === 'message.delta').map((event) => event.text), ['initial']);
    const delta = events.find((event) => event.type === 'message.delta');
    const final = events.find((event) => event.type === 'message.completed');
    assert.equal(final?.type === 'message.completed' ? final.text : null, 'final replacement');
    assert.equal(delta?.type === 'message.delta' ? delta.messageId : null, final?.type === 'message.completed' ? final.messageId : null);
    assert.equal(JSON.stringify(events).includes('do-not-emit'), false);
    await assert.rejects(runtime.interrupt('run1'));
    await assert.rejects(runtime.startTurn({ runId: 'run1', text: 'complete' }));
  } finally { await runtime.close(); }
  assert.equal(exited(), true);
});

test('明确 resume、问题映射与答案结构', async () => {
  const { runtime, events } = setup('saved-thread');
  try {
    await runtime.startTurn({ runId: 'question-run', text: 'question' });
    await until(() => events.some((event) => event.type === 'interaction'));
    const event = events.find((event) => event.type === 'interaction');
    if (event?.type !== 'interaction') throw new Error('missing question');
    assert.equal(event.interaction.kind, 'question');
    await assert.rejects(runtime.respond(event.interaction.id, { action: 'allow-once' }));
    await runtime.respond(event.interaction.id, { action: 'submit', answers: { target: ['A'] } });
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => event.type === 'context' && event.nativeContextId === 'saved-thread'));
  } finally { await runtime.close(); }
});

test('interrupt 受理不假装结束，旧 run 拒绝，等待 turn/completed', async () => {
  const { runtime, events } = setup();
  try {
    await runtime.startTurn({ runId: 'interrupt-run', text: 'wait' });
    await assert.rejects(runtime.interrupt('old-run'));
    await runtime.interrupt('interrupt-run');
    assert.equal(events.some((event) => event.type === 'turn.completed'), false);
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.outcome === 'interrupted'));
  } finally { await runtime.close(); }
});

test('initialize 在途时立即停止：不发送 turn/start，确认 interrupted 后允许新轮次', async () => {
  const { runtime, events, submitted } = setup();
  try {
    const starting = runtime.startTurn({ runId: 'stop-initialize', text: 'never-submit' });
    await runtime.interrupt('stop-initialize');
    await starting;
    assert.equal(submitted(), false);
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.runId === 'stop-initialize' && event.outcome === 'interrupted'));
    await runtime.startTurn({ runId: 'next-run', text: 'complete' });
    await until(() => events.some((event) => event.type === 'turn.completed' && event.runId === 'next-run'));
  } finally { await runtime.close(); }
});

test('turn/start 在途时停止：收到原生 turnId 后中断且等待真正完成', async () => {
  const { runtime, events, submitted } = setup();
  try {
    const starting = runtime.startTurn({ runId: 'stop-starting', text: 'early-interrupt' });
    await until(submitted);
    await runtime.interrupt('stop-starting');
    assert.equal(events.some((event) => event.type === 'turn.completed'), false);
    await starting;
    assert.equal(events.some((event) => event.type === 'turn.completed'), false);
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.outcome === 'interrupted'));
  } finally { await runtime.close(); }
});

test('原生问题 ID __proto__ 作为普通 JSON 键完整返回', async () => {
  const { runtime, events } = setup();
  try {
    await runtime.startTurn({ runId: 'proto-question', text: 'question-proto' });
    await until(() => events.some((event) => event.type === 'interaction'));
    const event = events.find((event) => event.type === 'interaction');
    if (event?.type !== 'interaction') throw new Error('missing question');
    const answers: Record<string, string[]> = Object.create(null);
    answers.__proto__ = ['A'];
    await runtime.respond(event.interaction.id, { action: 'submit', answers });
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.outcome === 'completed'));
  } finally { await runtime.close(); }
});

test('未知服务端请求明确拒绝，不自动放行', async () => {
  const { runtime, events } = setup();
  try {
    await runtime.startTurn({ runId: 'unknown-run', text: 'unknown' });
    await until(() => events.some((event) => event.type === 'turn.completed'));
    assert.ok(events.some((event) => event.type === 'interaction' && event.interaction.kind === 'unsupported'));
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.outcome === 'failed'));
  } finally { await runtime.close(); }
});

test('文件变更审批的 deny/cancel-turn 不变成会话永久批准', async () => {
  for (const action of ['deny', 'cancel-turn'] as const) {
    const { runtime, events } = setup();
    try {
      await runtime.startTurn({ runId: `file-${action}`, text: action === 'deny' ? 'file-deny' : 'file-cancel' });
      await until(() => events.some((event) => event.type === 'interaction'));
      const event = events.find((event) => event.type === 'interaction');
      if (event?.type !== 'interaction') throw new Error('missing approval');
      await runtime.respond(event.interaction.id, { action });
      await until(() => events.some((event) => event.type === 'turn.completed'));
      assert.ok(events.some((event) => event.type === 'turn.completed' && event.outcome === (action === 'deny' ? 'completed' : 'interrupted')));
    } finally { await runtime.close(); }
  }
});

test('关闭拒绝挂起请求并让旧回答失效', async () => {
  const { runtime, events } = setup();
  await runtime.startTurn({ runId: 'pending-run', text: 'pending' });
  await until(() => events.some((event) => event.type === 'interaction'));
  const event = events.find((event) => event.type === 'interaction');
  await runtime.close();
  if (event?.type !== 'interaction') throw new Error('missing approval');
  await assert.rejects(runtime.respond(event.interaction.id, { action: 'allow-once' }));
  assert.ok(events.some((event) => event.type === 'interaction.resolved'));
  assert.ok(events.some((event) => event.type === 'process.exited'));
});

test('关闭等待真实退出，忽略 EOF/SIGTERM 时升级 SIGKILL', async () => {
  const { runtime, events } = setup();
  await runtime.startTurn({ runId: 'stubborn-run', text: 'stubborn' });
  const closing = runtime.close();
  assert.strictEqual(runtime.close(), closing);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(events.some((event) => event.type === 'process.exited'), false);
  await closing;
  assert.ok(events.some((event) => event.type === 'process.exited'));
});

test('实际进程异常退出上报且无法继续启动', async () => {
  const { runtime, events } = setup();
  try {
    await runtime.startTurn({ runId: 'exit-run', text: 'exit' });
    await until(() => events.some((event) => event.type === 'process.exited'));
    assert.ok(events.some((event) => event.type === 'process.exited' && event.runId === 'exit-run'));
    await assert.rejects(runtime.startTurn({ runId: 'new-run', text: 'complete' }));
  } finally { await runtime.close(); }
});

test('有界 JSONL 超大帧终止实际进程', async () => {
  const { runtime, events } = setup();
  try {
    await runtime.startTurn({ runId: 'oversize-run', text: 'oversize' });
    await until(() => events.some((event) => event.type === 'process.exited'));
  } finally { await runtime.close(); }
});

test('检测不存在的 CLI 只返回不可用', async () => {
  const availability = await detectCodex('/nonexistent/xterminal-codex-test');
  assert.equal(availability.available, false);
  assert.equal(availability.version, null);
});
