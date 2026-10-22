import assert from 'node:assert/strict';
import { CodexRuntime } from '../packages/engines/codex/src/runtime.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const cwd = await mkdtemp(join(tmpdir(), 'xterminal-codex-turn-'));
const runId = randomUUID();
const model = process.argv[2] === '--model' ? process.argv[3] : undefined;
let context = false; let toolRequested = false;
const diagnostics = [];
const messages = new Map();
let finishResolve; const finished = new Promise(resolve => { finishResolve = resolve; });
const runtime = new CodexRuntime({ cwd, nativeContextId: null, onEvent: event => {
  if (event.type === 'context') context = true;
  if (event.type === 'message.delta') messages.set(event.messageId, (messages.get(event.messageId) ?? '') + event.text);
  if (event.type === 'message.completed') messages.set(event.messageId, event.text);
  if (event.type === 'interaction') {
    toolRequested = true;
    void runtime.respond(event.interaction.id, { action: event.interaction.actions.includes('deny') ? 'deny' : 'cancel-turn' });
  }
  if (event.type === 'tool') toolRequested = true;
  if (event.type === 'turn.completed') finishResolve(event);
  if (event.type === 'process.exited') finishResolve({ outcome: 'failed', error: event.error });
} }, { onDiagnostic: value => diagnostics.push(value) });
let timer;
try {
  timer = setTimeout(() => finishResolve({ outcome: 'timeout' }), 60_000);
  await runtime.startTurn({ runId, text: '只回复 XTERMINAL_CODEX_OK，不使用任何工具，不读取或修改文件。', ...(model ? { model } : {}) });
  const outcome = await finished;
  if (outcome.outcome !== 'completed') {
    await mkdir('docs/validation/2026-10-22-agent', { recursive: true });
    await writeFile('docs/validation/2026-10-22-agent/codex-turn-failure.json', JSON.stringify({ passed: false, outcome: outcome.outcome, error: outcome.error, diagnostics, modelTurnStarted: true, at: new Date().toISOString() }, null, 2));
  }
  assert.equal(outcome.outcome, 'completed', outcome.error ?? outcome.outcome);
  assert.equal(toolRequested, false);
  assert.ok([...messages.values()].join('\n').includes('XTERMINAL_CODEX_OK'));
  assert.ok(context);
  const result = { passed: true, engine: 'codex', model: model ?? 'CLI default', realModelTurn: true, contextSaved: context, streamingOrFinalMessage: true, terminalOutcome: outcome.outcome, toolsUsed: false, at: new Date().toISOString() };
  await mkdir('docs/validation/2026-10-22-agent', { recursive: true });
  await writeFile('docs/validation/2026-10-22-agent/codex-turn.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { clearTimeout(timer); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
