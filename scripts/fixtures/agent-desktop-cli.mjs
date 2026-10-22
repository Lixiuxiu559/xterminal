#!/usr/bin/env node
/** Desktop E2E subprocess fixture. Usage: node agent-desktop-cli.mjs <codex|claude> [...official CLI args]. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const root = process.env.XTERMINAL_AGENT_FIXTURE_ROOT;
if (!root || !isAbsolute(root)) { process.stderr.write('XTERMINAL_AGENT_FIXTURE_ROOT must name an absolute temporary directory.\n'); process.exit(2); }
mkdirSync(join(root, 'contexts'), { recursive: true, mode: 0o700 });
if (process.argv[2] === '--self-test') { await selfTest(); process.exit(0); }
const engine = process.argv[2];
if (engine !== 'codex' && engine !== 'claude') { process.stderr.write('Expected engine: codex or claude.\n'); process.exit(2); }
const args = process.argv.slice(3);
let context = null;
let resumed = false;
let active = null;
let closed = false;
const callbacks = new Map();
const timers = new Set();
function metadata(method, fields = {}) {
  const row = { engine, method, context: context?.id ?? null, pid: process.pid, cwd: process.cwd(), model: active?.model ?? null };
  for (const key of ['decision', 'answers', 'text', 'model']) if (fields[key] !== undefined) row[key] = fields[key];
  appendFileSync(join(root, 'metadata.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
}
function output(frame) { if (!closed) process.stdout.write(JSON.stringify(frame) + '\n'); }
function later(callback, delay = 30) { const timer = setTimeout(() => { timers.delete(timer); if (!closed) callback(); }, delay); timers.add(timer); }
function contextPath(id) { return join(root, 'contexts', `${engine}-${createHash('sha256').update(id).digest('hex')}.json`); }
function saveContext() { writeFileSync(contextPath(context.id), JSON.stringify(context), { mode: 0o600 }); }
function startContext(id) {
  if (id) {
    const file = contextPath(id);
    if (!existsSync(file)) throw new Error('RESUME_CONTEXT_NOT_FOUND');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.id !== id || stored.engine !== engine || stored.cwd !== process.cwd()) throw new Error('RESUME_CONTEXT_MISMATCH');
    context = stored; resumed = true;
  } else { context = { id: randomUUID(), engine, cwd: process.cwd(), marker: null }; resumed = false; saveContext(); }
}
function respond(id, result) { output({ id, result }); }
function notify(method, params) { output({ method, params }); }
function binding(turn = active) { return { threadId: context.id, turnId: turn.id }; }
function finish(text, outcome = 'completed', turn = active) {
  if (!turn || active !== turn) return;
  if (engine === 'codex') {
    if (text) notify('item/completed', { ...binding(turn), item: { type: 'agentMessage', id: turn.messageId, text } });
    notify('turn/completed', { threadId: context.id, turn: { id: turn.id, status: outcome, items: [] } });
  } else {
    if (text) output({ type: 'assistant', session_id: context.id, parent_tool_use_id: null, message: { id: turn.messageId, role: 'assistant', content: [{ type: 'text', text }] } });
    output({ type: 'result', subtype: outcome === 'failed' ? 'error_during_execution' : 'success', is_error: outcome === 'failed', result: text ?? '', errors: outcome === 'failed' ? [text ?? 'FIXTURE_ERROR'] : [], session_id: context.id, user_message_uuid: turn.uuid, ...(outcome === 'interrupted' ? { terminal_reason: 'aborted_streaming' } : {}) });
  }
  active = null; callbacks.clear();
}
function delta(turn) {
  if (engine === 'codex') notify('item/agentMessage/delta', { ...binding(turn), itemId: turn.messageId, delta: '部分' });
  else {
    output({ type: 'stream_event', session_id: context.id, parent_tool_use_id: null, event: { type: 'message_start', message: { id: turn.messageId } } });
    output({ type: 'stream_event', session_id: context.id, parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '部分' } } });
  }
}
const questions = [
  { id: 'target', header: '单选问题', question: '这次优先处理什么？', options: [{ label: 'A', description: '先完成界面' }, { label: 'B', description: '先完成逻辑' }], multiSelect: false, multiple: false },
  { id: 'checks', header: '多选问题', question: '需要哪些验证？', options: [{ label: 'A', description: '验证中文输入' }, { label: 'B', description: '验证 emoji' }, { label: 'C', description: '验证上下文恢复' }], multiSelect: true, multiple: true },
];
function requestPermission(turn, question = false) {
  const requestId = `fixture-request-${randomUUID()}`;
  callbacks.set(requestId, frame => {
    if (active !== turn) return;
    const result = engine === 'codex' ? frame.result : frame.response?.response;
    if (question) {
      const answers = engine === 'codex' ? result?.answers : result?.updatedInput?.answers;
      metadata('interaction.answer', { decision: result?.behavior ?? (frame.error ? 'cancel' : 'submit'), answers: answers ?? {} });
      if (frame.error || result?.behavior === 'deny') { finish('E2E_DENIED 中文🚀'); return; }
      const valid = engine === 'codex'
        ? JSON.stringify(answers?.target?.answers) === JSON.stringify(['A']) && JSON.stringify(answers?.checks?.answers) === JSON.stringify(['补充答案'])
        : answers?.[questions[0].question] === 'A' && answers?.[questions[1].question] === 'B, 补充答案';
      if (!answers || Object.keys(answers).length !== 2 || !valid) { finish('E2E_BAD_ANSWERS', 'failed'); return; }
      finish('E2E_ANSWERED 中文🚀');
    } else {
      const decision = engine === 'codex' ? result?.decision : result?.behavior;
      metadata('interaction.decision', { decision: decision ?? 'cancel' });
      if (decision === 'cancel' || result?.interrupt || frame.error) { later(() => finish('', 'interrupted', turn), 100); return; }
      if (engine === 'codex') notify('item/completed', { ...binding(turn), item: { type: 'commandExecution', id: `${turn.id}-tool`, command: 'fixture only; no shell command executed', status: decision === 'accept' ? 'completed' : 'declined' } });
      finish(`${decision === 'accept' || decision === 'allow' ? 'E2E_ALLOWED' : 'E2E_DENIED'} 中文🚀`);
    }
  });
  if (engine === 'codex') {
    if (!question) notify('item/started', { ...binding(turn), item: { type: 'commandExecution', id: `${turn.id}-tool`, command: 'fixture only; no shell command executed', status: 'inProgress' } });
    output({ id: requestId, method: question ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval', params: { ...binding(turn), itemId: `${turn.id}-tool`, ...(question ? { questions: questions.map(({ multiSelect, multiple, ...question }) => question) } : { command: 'fixture only; no shell command executed', reason: 'E2E permission decision only', cwd: process.cwd() }) } });
  } else {
    if (!question) output({ type: 'tool_progress', session_id: context.id, tool_use_id: `${turn.id}-tool`, tool_name: 'Bash', elapsed_time_seconds: 0 });
    output({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: question ? 'AskUserQuestion' : 'Bash', tool_use_id: `${turn.id}-tool`, input: question ? { questions } : { command: 'fixture only; no shell command executed' } } });
  }
}
function scenario(turn) {
  if (active !== turn) return;
  delta(turn);
  if (turn.text.startsWith('E2E_MESSAGE:')) {
    context.marker = turn.text.slice('E2E_MESSAGE:'.length); saveContext();
    later(() => finish(`E2E_MESSAGE:${context.marker} 中文🚀`, 'completed', turn), 80);
  } else if (turn.text === 'E2E_APPROVAL') requestPermission(turn);
  else if (turn.text === 'E2E_QUESTION') requestPermission(turn, true);
  else if (turn.text === 'E2E_STOP') { /* Remain alive until an explicit interrupt or stdin EOF. */ }
  else if (turn.text === 'E2E_RESUME') {
    if (!resumed || !context.marker) finish('E2E_RESUME_REQUIRES_PERSISTED_CONTEXT', 'failed');
    else later(() => finish(`E2E_RESUMED:${context.marker} 中文🚀`, 'completed', turn));
  } else finish('E2E_UNKNOWN_SCENARIO', 'failed');
}
function begin(text, extra = {}) {
  if (active) throw new Error('TURN_ALREADY_ACTIVE');
  if (!/^E2E_(MESSAGE:|APPROVAL$|QUESTION$|STOP$|RESUME$)/u.test(text)) throw new Error('ONLY_E2E_SCENARIOS_ALLOWED');
  active = { id: randomUUID(), messageId: randomUUID(), text, ...extra };
  metadata('turn.start', { text, model: extra.model ?? null }); return active;
}
if (args.includes('--version')) { metadata('version'); console.log(engine === 'codex' ? 'codex-cli 0.157.0' : '2.1.304 (Claude Code)'); process.exit(0); }
if ((args[0] === 'auth' && args[1] === 'status') || (args[0] === 'login' && args[1] === 'status')) { metadata('auth.status'); console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (engine === 'claude') {
  const resumeAt = args.indexOf('--resume');
  try { startContext(resumeAt >= 0 ? args[resumeAt + 1] : null); }
  catch { process.stderr.write('Fixture resume context is missing or mismatched.\n'); process.exit(3); }
  metadata(resumed ? 'session.resume' : 'session.start');
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { process.exitCode = 4; lines.close(); return; }
  let frame;
  try {
    frame = JSON.parse(line);
    if (engine === 'codex') {
      if (!frame.method) { const callback = callbacks.get(frame.id); callbacks.delete(frame.id); callback?.(frame); return; }
      const { id, method, params = {} } = frame;
      metadata(method);
      if (method === 'initialize') respond(id, { userAgent: 'fixture-codex/0.157.0' });
      else if (method === 'initialized') { /* Notification, no response. */ }
      else if (method === 'account/read') respond(id, { requiresOpenaiAuth: false, account: null });
      else if (method === 'thread/start' || method === 'thread/resume') { startContext(method === 'thread/resume' ? params.threadId : null); metadata(method); respond(id, { thread: { id: context.id } }); }
      else if (method === 'model/list') respond(id, { data: [{ id: 'e2e-codex-model', displayName: 'E2E fixture model', isDefault: true }], nextCursor: null });
      else if (method === 'turn/start') {
        if (params.threadId !== context?.id) throw new Error('THREAD_MISMATCH');
        const turn = begin(params.input?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '', { model: params.model ?? null });
        respond(id, { turn: { id: turn.id, status: 'inProgress', items: [] } }); later(() => scenario(turn), 25);
      } else if (method === 'turn/interrupt') {
        if (!active || params.threadId !== context.id || params.turnId !== active.id) throw new Error('INTERRUPT_CONTEXT_MISMATCH');
        const turn = active; respond(id, {}); later(() => finish('', 'interrupted', turn), 100);
      } else output({ id, error: { code: -32601, message: 'UNSUPPORTED_FIXTURE_METHOD' } });
    } else {
      if (frame.type === 'control_request') {
        const subtype = frame.request?.subtype;
        metadata(subtype === 'interrupt' ? 'turn.interrupt' : subtype ?? 'control.unknown');
        output({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: subtype === 'interrupt' ? { still_queued: [] } : {} } });
        if (subtype === 'interrupt' && active) { const turn = active; later(() => finish('', 'interrupted', turn), 100); }
      } else if (frame.type === 'user') {
        const turn = begin(typeof frame.message?.content === 'string' ? frame.message.content : '', { uuid: frame.uuid });
        output({ type: 'system', subtype: 'init', session_id: context.id }); later(() => scenario(turn), 25);
      } else if (frame.type === 'control_response') { const callback = callbacks.get(frame.response?.request_id); callbacks.delete(frame.response?.request_id); callback?.(frame); }
    }
  } catch (error) {
    const reason = error instanceof Error && ['RESUME_CONTEXT_NOT_FOUND', 'RESUME_CONTEXT_MISMATCH', 'TURN_ALREADY_ACTIVE', 'ONLY_E2E_SCENARIOS_ALLOWED', 'THREAD_MISMATCH', 'INTERRUPT_CONTEXT_MISMATCH'].includes(error.message) ? error.message : 'INVALID_FRAME';
    metadata('fixture.error', { decision: reason });
    if (engine === 'codex' && frame?.id !== undefined) output({ id: frame.id, error: { code: -32602, message: reason } });
    else if (active) finish('E2E_PROTOCOL_ERROR', 'failed');
    else { process.exitCode = 4; lines.close(); }
  }
});
lines.on('close', () => { closed = true; for (const timer of timers) clearTimeout(timer); callbacks.clear(); process.exit(process.exitCode ?? 0); });

async function selfTest() {
  const assert = await import('node:assert/strict');
  const { CodexRuntime, detectCodex } = await import('../../packages/engines/codex/src/runtime.ts');
  const { ClaudeRuntime, detectClaude } = await import('../../packages/engines/claude/src/runtime.ts');
  const script = fileURLToPath(import.meta.url);
  const bin = join(root, 'self-test-bin'); mkdirSync(bin, { recursive: true });
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  async function waitFor(check) { const until = Date.now() + 5000; while (!check()) { if (Date.now() >= until) throw new Error('fixture self-test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
  for (const [kind, Runtime] of [['codex', CodexRuntime], ['claude', ClaudeRuntime]]) {
    const executable = join(bin, kind);
    writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${kind} "$@"\n`, { mode: 0o700 });
    assert.equal((await (kind === 'codex' ? detectCodex(executable) : detectClaude(executable))).available, true);
    let events = []; let runtime = new Runtime({ cwd: root, executablePath: executable, nativeContextId: null, onEvent: event => events.push(event) });
    let contextId;
    async function turn(text, answer) {
      const runId = randomUUID(); const before = events.length;
      await runtime.startTurn({ runId, text });
      if (answer) {
        await waitFor(() => events.slice(before).some(event => event.type === 'interaction'));
        const interaction = events.slice(before).find(event => event.type === 'interaction').interaction;
        await runtime.respond(interaction.id, typeof answer === 'function' ? answer(interaction) : answer);
      }
      await waitFor(() => events.some(event => event.type === 'turn.completed' && event.runId === runId));
      contextId = events.find(event => event.type === 'context')?.nativeContextId ?? contextId;
      return events.filter(event => event.runId === runId);
    }
    try {
      if (kind === 'codex') assert.deepEqual(await runtime.models(), [{ id: 'e2e-codex-model', label: 'E2E fixture model', isDefault: true }]);
      const message = await turn('E2E_MESSAGE:自测marker');
      assert.ok(message.some(event => event.type === 'message.delta' && event.text === '部分'));
      assert.ok(message.some(event => event.type === 'message.completed' && event.text === 'E2E_MESSAGE:自测marker 中文🚀'));
      for (const [action, expected] of [['allow-once', 'E2E_ALLOWED'], ['deny', 'E2E_DENIED']]) {
        const result = await turn('E2E_APPROVAL', { action }); assert.ok(result.some(event => event.type === 'message.completed' && event.text.startsWith(expected)));
      }
      const question = await turn('E2E_QUESTION', interaction => ({ action: 'submit', answers: Object.fromEntries(interaction.questions.map((question, index) => [question.id, index ? kind === 'codex' ? ['补充答案'] : ['B', '补充答案'] : ['A']])) }));
      assert.ok(question.some(event => event.type === 'message.completed' && event.text.startsWith('E2E_ANSWERED')));
      const stopId = randomUUID(); await runtime.startTurn({ runId: stopId, text: 'E2E_STOP' });
      await waitFor(() => events.some(event => event.type === 'message.delta' && event.runId === stopId));
      const stopAt = Date.now(); await runtime.interrupt(stopId);
      await waitFor(() => events.some(event => event.type === 'turn.completed' && event.runId === stopId));
      assert.ok(Date.now() - stopAt >= 80);
      assert.equal(events.find(event => event.type === 'turn.completed' && event.runId === stopId).outcome, 'interrupted');
      await runtime.close();
      events = []; runtime = new Runtime({ cwd: root, executablePath: executable, nativeContextId: contextId, onEvent: event => events.push(event) });
      const recovered = await turn('E2E_RESUME');
      assert.ok(recovered.some(event => event.type === 'message.completed' && event.text.includes('自测marker')));
      console.log(`${kind}: version/protocol/message/approval/question/delayed-stop/persisted-resume passed`);
    } finally { await runtime.close(); }
  }
}
