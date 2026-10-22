import assert from 'node:assert/strict';
import { ClaudeRuntime, detectClaude } from '../packages/engines/claude/src/runtime.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const cwd = await mkdtemp(join(tmpdir(), 'xterminal-claude-turn-'));
const runId = randomUUID(); const messages = new Map();
let context = false; let toolRequested = false;
let resolve; const finished = new Promise(res => { resolve = res; });
const runtime = new ClaudeRuntime({ cwd, nativeContextId: null, onEvent: event => {
  if (event.type === 'context') context = true;
  if (event.type === 'message.delta') messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text);
  if (event.type === 'message.completed') messages.set(event.messageId, event.text);
  if (event.type === 'interaction') {
    toolRequested = true;
    void runtime.respond(event.interaction.id, { action: event.interaction.actions.includes('deny') ? 'deny' : 'cancel-turn' });
  }
  if (event.type === 'tool') toolRequested = true;
  if (event.type === 'turn.completed') resolve(event);
  if (event.type === 'process.exited') resolve({ outcome: 'failed', error: event.error });
} });
let timer;
try {
  const capability = await detectClaude();
  assert.equal(capability.available, true, capability.reason ?? 'Claude unavailable');
  timer = setTimeout(() => resolve({ outcome: 'timeout', error: '真实轮次观察超时' }), 60_000);
  await runtime.startTurn({ runId, text: '只回复 XTERMINAL_CLAUDE_OK，不使用任何工具，不读取或修改文件。' });
  const outcome = await finished;
  const result = { passed: outcome.outcome === 'completed' && !toolRequested && context && [...messages.values()].join('\n').includes('XTERMINAL_CLAUDE_OK'), engine: 'claude', version: capability.version, realModelTurn: true, contextSaved: context, terminalOutcome: outcome.outcome, toolsUsed: toolRequested, ...(outcome.error ? { error: outcome.error } : {}), at: new Date().toISOString() };
  await mkdir('docs/validation/2026-10-22-agent', { recursive: true });
  await writeFile('docs/validation/2026-10-22-agent/claude-turn.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  assert.equal(result.passed, true);
} finally { clearTimeout(timer); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
