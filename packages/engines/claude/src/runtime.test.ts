import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Options, SDKMessage, SDKUserMessage, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEngineEvent } from '../../../protocol/src/agent.ts';
import { ClaudeRuntime, detectClaude } from './runtime.ts';

class Messages implements AsyncIterable<SDKMessage> {
  values: SDKMessage[] = [];
  wake?: () => void;
  ended = false;
  push(message: unknown) { this.values.push(message as SDKMessage); this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended || this.values.length) {
      const value = this.values.shift();
      if (value) yield value;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
class Child extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough();
  killed = false; exitCode: number | null = null;
  signals: string[] = [];
  kill(signal: string) { this.killed = true; this.signals.push(signal); return true; }
  exit() { this.exitCode = 0; this.emit('exit', 0, null); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(condition: () => unknown) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
  assert.fail('fake SDK operation did not settle');
}
function fixture(input: { resume?: string; process?: boolean; timeoutMs?: number; interruptReject?: boolean } = {}) {
  const events: AgentEngineEvent[] = [];
  const messages = new Messages();
  const prompts: SDKUserMessage[] = [];
  let sdkOptions!: Options;
  let calls = 0, closes = 0, interrupts = 0;
  const child = new Child();
  const runtime = new ClaudeRuntime({ cwd: '/test/project', nativeContextId: input.resume ?? null, executablePath: '/official/claude', onEvent: event => events.push(event) }, {
    timeoutMs: input.timeoutMs ?? 100,
    spawn: () => child as unknown as SpawnedProcess,
    query: args => {
      calls++; sdkOptions = args.options;
      if (input.process) sdkOptions.spawnClaudeCodeProcess!({ command: '/fake', args: [], env: {}, signal: new AbortController().signal });
      void (async () => { for await (const prompt of args.prompt) prompts.push(prompt); })();
      return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), interrupt: async () => { interrupts++; if (input.interruptReject) throw new Error('SDK not initialized'); return { still_queued: [] }; }, close: () => { closes++; messages.end(); } };
    },
  });
  const start = async (id = 'run-1', text = 'hello') => { await runtime.startTurn({ runId: id, text }); await until(() => prompts.length === calls || prompts.some(p => p.message.content === text)); };
  const result = (extra = {}) => messages.push({ type: 'result', subtype: 'success', result: 'Final', is_error: false, session_id: input.resume ?? 'native-1', user_message_uuid: prompts.at(-1)?.uuid, ...extra });
  return { runtime, events, messages, prompts, child, start, result, get options() { return sdkOptions; }, get calls() { return calls; }, get closes() { return closes; }, get interrupts() { return interrupts; } };
}

test('persistent async prompt stream, explicit resume, deltas and final canonical overwrite', async () => {
  const f = fixture({ resume: 'native-1' });
  await f.start();
  assert.equal(f.options.resume, 'native-1');
  assert.equal(f.options.continue, undefined);
  assert.equal(f.options.permissionMode, 'default');
  assert.deepEqual(f.options.settingSources, ['user', 'project', 'local']);
  assert.deepEqual(f.options.systemPrompt, { type: 'preset', preset: 'claude_code' });
  assert.equal(f.options.pathToClaudeCodeExecutable, '/official/claude');
  f.messages.push({ type: 'system', subtype: 'init', session_id: 'native-1' });
  f.messages.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1' } }, parent_tool_use_id: null, session_id: 'native-1' });
  f.messages.push({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Par' } }, parent_tool_use_id: null, session_id: 'native-1' });
  f.messages.push({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: 'Partial' }] }, parent_tool_use_id: null, session_id: 'native-1' });
  f.result();
  await until(() => f.events.some(e => e.type === 'turn.completed'));
  assert.deepEqual(f.events.filter(e => e.type === 'message.delta'), [{ type: 'message.delta', runId: 'run-1', messageId: 'message-1', text: 'Par' }]);
  assert.deepEqual(f.events.filter(e => e.type === 'message.completed').at(-1), { type: 'message.completed', runId: 'run-1', messageId: 'message-1', text: 'Final' });
  assert.ok(f.events.some(e => e.type === 'context' && e.nativeContextId === 'native-1'));
  await f.start('run-2', 'follow up');
  assert.equal(f.calls, 1);
  assert.equal(f.prompts.length, 2);
  f.result(); await until(() => f.events.filter(e => e.type === 'turn.completed').length === 2);
  await f.runtime.close();
});

test('permissions require an explicit answer; allow-once never writes persistent rules', async () => {
  const f = fixture(); await f.start();
  const abort = new AbortController();
  let settled = false;
  const pending = f.options.canUseTool!('Bash', { command: '<html>' + 'x'.repeat(8000) }, { signal: abort.signal, toolUseID: 'tool-1', requestId: 'permission-1' }).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false);
  const event = f.events.find(e => e.type === 'interaction'); assert.equal(event?.type, 'interaction');
  if (event?.type !== 'interaction') throw new Error('missing interaction');
  assert.ok(event.interaction.detail.length <= 2000);
  assert.equal(event.interaction.detail.includes('<html>'), false);
  await f.runtime.respond(event.interaction.id, { action: 'allow-once' });
  const permission = await pending;
  assert.equal(permission?.behavior, 'allow');
  assert.equal(permission && 'updatedPermissions' in permission, false);
  await assert.rejects(f.runtime.respond(event.interaction.id, { action: 'allow-once' }), { code: 'INTERACTION_EXPIRED' });
  const denied = f.options.canUseTool!('Write', { file_path: '/tmp/file' }, { signal: abort.signal, toolUseID: 'tool-2', requestId: 'permission-2' });
  const event2 = f.events.filter(e => e.type === 'interaction').at(-1)!;
  if (event2.type !== 'interaction') throw new Error('missing interaction');
  await f.runtime.respond(event2.interaction.id, { action: 'deny' });
  assert.equal((await denied)?.behavior, 'deny');
  await f.runtime.close();
});

test('AskUserQuestion preserves native questions and returns selected plus freeform answers', async () => {
  const f = fixture(); await f.start();
  const input = { questions: [{ question: 'Which database?', header: 'Database', options: [{ label: 'SQLite', description: 'Local' }, { label: 'Postgres' }], multiSelect: true }] };
  const response = f.options.canUseTool!('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'question-1', requestId: 'question-request' });
  const event = f.events.find(e => e.type === 'interaction');
  if (event?.type !== 'interaction') throw new Error('missing question');
  assert.equal(event.interaction.kind, 'question');
  await assert.rejects(f.runtime.respond(event.interaction.id, { action: 'allow-once' }), { code: 'INVALID_ANSWER' });
  await assert.rejects(f.runtime.respond(event.interaction.id, { action: 'submit', answers: {} }), { code: 'INVALID_ANSWER' });
  await f.runtime.respond(event.interaction.id, { action: 'submit', answers: { [event.interaction.questions![0].id]: ['SQLite', 'Other choice'] } });
  const result = await response;
  assert.equal(result?.behavior, 'allow');
  if (result?.behavior !== 'allow') throw new Error('question was denied');
  assert.deepEqual(result.updatedInput?.questions, input.questions);
  assert.equal(Object.getPrototypeOf(result.updatedInput?.answers), null);
  assert.equal((result.updatedInput?.answers as Record<string, string>)['Which database?'], 'SQLite, Other choice');
  await f.runtime.close();
});

test('unsupported plan/elicitation interactions cannot be approved; aborted permission is retired', async () => {
  const f = fixture(); await f.start();
  const signal = new AbortController();
  const pending = f.options.canUseTool!('ExitPlanMode', {}, { signal: signal.signal, toolUseID: 'plan', requestId: 'plan-request' });
  const event = f.events.find(e => e.type === 'interaction');
  if (event?.type !== 'interaction') throw new Error('missing unsupported interaction');
  assert.equal(event.interaction.kind, 'unsupported');
  await assert.rejects(f.runtime.respond(event.interaction.id, { action: 'allow-once' }), { code: 'INVALID_ANSWER' });
  signal.abort(); assert.equal((await pending)?.behavior, 'deny');
  assert.ok(f.events.some(e => e.type === 'interaction.resolved' && e.interactionId === event.interaction.id));
  const elicitation = f.options.onElicitation!({ message: 'Need auth', mode: 'form', serverName: 'untrusted', requestedSchema: { type: 'object', properties: {} } }, { signal: new AbortController().signal, requestId: 'request-1' });
  const second = f.events.filter(e => e.type === 'interaction').at(-1)!;
  if (second.type !== 'interaction') throw new Error('missing elicitation');
  await f.runtime.respond(second.interaction.id, { action: 'deny' });
  assert.deepEqual(await elicitation, { action: 'decline' });
  await f.runtime.close();
});

test('interrupt waits for a terminal result, not only control acknowledgment', async () => {
  const f = fixture(); await f.start();
  let finished = false;
  const interrupt = f.runtime.interrupt('run-1').then(() => { finished = true; });
  await tick(); assert.equal(f.interrupts, 1); assert.equal(finished, false);
  assert.equal(f.events.some(e => e.type === 'turn.completed'), false);
  f.result({ terminal_reason: 'aborted_streaming' }); await interrupt;
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'interrupted'));
  await f.runtime.close();
});

test('unconfirmed interruption closes the Query before declaring the turn interrupted', async () => {
  const f = fixture({ timeoutMs: 10 }); await f.start();
  await f.runtime.interrupt('run-1');
  assert.equal(f.closes, 1);
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'interrupted'));
  await assert.rejects(f.runtime.startTurn({ runId: 'later', text: 'retry' }), { code: 'ENGINE_EXITED' });
  await f.runtime.close();
});

test('close waits for actual child exit and closes the SDK Query exactly once', async () => {
  const f = fixture({ process: true }); await f.start();
  let finished = false;
  const close = f.runtime.close().then(() => { finished = true; });
  await tick(); assert.equal(f.closes, 1); assert.equal(finished, false);
  f.child.exit(); await close; await f.runtime.close(); assert.equal(f.closes, 1);
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'interrupted'));
});

test('unconfirmed process exit rejects even after SIGKILL instead of claiming cleanup', async () => {
  const f = fixture({ process: true, timeoutMs: 10 }); await f.start();
  await assert.rejects(f.runtime.close(), { code: 'CLAUDE_TIMEOUT' });
  assert.deepEqual(f.child.signals, ['SIGKILL']);
  f.child.exit();
});

test('unexpected stream exit fails active turn; explicit context mismatch never falls back', async () => {
  const f = fixture({ resume: 'expected-context' }); await f.start();
  f.messages.push({ type: 'system', subtype: 'init', session_id: 'wrong-context' });
  await until(() => f.events.some(e => e.type === 'process.exited'));
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'failed'));
  assert.ok(f.closes > 0);
  await assert.rejects(f.runtime.startTurn({ runId: 'new-run', text: 'retry' }), { code: 'ENGINE_EXITED' });
  await f.runtime.close();
  const exited = fixture(); await exited.start(); exited.messages.end();
  await until(() => exited.events.some(e => e.type === 'process.exited'));
  assert.ok(exited.events.some(e => e.type === 'turn.completed' && e.outcome === 'failed'));
  await exited.runtime.close();
});

test('tool summaries are bounded text and never forward arbitrary tool result HTML', async () => {
  const f = fixture(); await f.start();
  f.messages.push({ type: 'assistant', parent_tool_use_id: null, session_id: 'native-1', message: { id: 'msg', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: '/tmp/<script>' } }] } });
  f.messages.push({ type: 'user', session_id: 'native-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: '<html>' + 'x'.repeat(10_000), is_error: false }] } });
  await until(() => f.events.filter(e => e.type === 'tool').length === 2);
  const tools = f.events.filter(e => e.type === 'tool');
  assert.equal(tools[0].tool.detail.includes('<'), false);
  assert.equal(tools[1].tool.detail, '工具执行完成');
  assert.equal(tools[1].tool.state, 'completed');
  await assert.rejects(f.runtime.startTurn({ runId: 'run-2', text: 'busy' }), { code: 'SESSION_BUSY' });
  await f.runtime.close();
});

test('detection version-locks the CLI and only returns a login availability whitelist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xterminal-claude-detect-'));
  try {
    const executable = join(root, 'claude'); const argumentsFile = join(root, 'arguments.json');
    writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(argumentsFile)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(process.argv[2] === '--version' ? '2.1.304 (Claude Code)' : JSON.stringify({loggedIn:true,authMethod:'oauth_token',secret:'must not be returned',email:'private@example.test'}));\n`, { mode: 0o700 });
    const result = await detectClaude(executable);
    assert.deepEqual(readFileSync(argumentsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [['--version'], ['auth', 'status', '--json']]);
    assert.deepEqual(result, { engine: 'claude', available: true, version: '2.1.304', reason: null });
    assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('early interruption removes an unconsumed prompt before it reaches the SDK', async () => {
  const f = fixture();
  const start = f.runtime.startTurn({ runId: 'early', text: 'must never execute' });
  const interrupt = f.runtime.interrupt('early');
  await Promise.all([start, interrupt]); await tick();
  assert.equal(f.prompts.length, 0);
  assert.equal(f.interrupts, 0);
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.runId === 'early' && e.outcome === 'interrupted'));
  await f.start('later', 'new explicit turn');
  assert.deepEqual(f.prompts.map(p => p.message.content), ['new explicit turn']);
  f.result(); await until(() => f.events.filter(e => e.type === 'turn.completed').length === 2);
  await f.runtime.close();
});

test('SDK interrupt rejection after delivery closes the actual process before confirming interruption', async () => {
  const f = fixture({ process: true, interruptReject: true }); await f.start();
  const interrupt = f.runtime.interrupt('run-1');
  await until(() => f.closes === 1);
  assert.equal(f.events.some(e => e.type === 'turn.completed'), false);
  f.child.exit(); await interrupt;
  assert.ok(f.events.some(e => e.type === 'turn.completed' && e.outcome === 'interrupted'));
});

test('a question literally named __proto__ is a normal own-property answer', async () => {
  const f = fixture(); await f.start();
  const pending = f.options.canUseTool!('AskUserQuestion', { questions: [{ question: '__proto__', header: 'Prototype', options: [{ label: 'Safe' }] }] }, { signal: new AbortController().signal, toolUseID: 'proto', requestId: 'proto-request' });
  const event = f.events.find(e => e.type === 'interaction');
  if (event?.type !== 'interaction') throw new Error('missing interaction');
  await f.runtime.respond(event.interaction.id, { action: 'submit', answers: { [event.interaction.questions![0].id]: ['Safe'] } });
  const response = await pending;
  if (response?.behavior !== 'allow') throw new Error('question denied');
  const answers = response.updatedInput!.answers as Record<string, string>;
  assert.equal(Object.getPrototypeOf(answers), null);
  assert.equal(Object.hasOwn(answers, '__proto__'), true);
  assert.equal(answers.__proto__, 'Safe');
  await f.runtime.close();
});
