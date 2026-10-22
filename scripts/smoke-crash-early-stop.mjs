import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeRuntime } from '../packages/engines/claude/src/runtime.ts';
import { childInputFd, guardProcess } from '../packages/engines/shared/src/process-guard.ts';
const cwd = await mkdtemp(join(tmpdir(), 'xterminal-guard-stop-'));
let unlock; const gate = new Promise(resolve => { unlock = resolve; });
let actualGuardReady; let child; let endOutput; let interrupts = 0;
const outputEnded = new Promise(resolve => { endOutput = resolve; });
const prompts = []; const events = [];
const runtime = new ClaudeRuntime({ cwd, nativeContextId: null, onEvent: event => events.push(event) }, {
  guard: (...args) => { const actual = guardProcess(...args); actualGuardReady = actual.ready; return { ready: Promise.all([actual.ready, gate]).then(() => {}), dispose: () => actual.dispose() }; },
  query: ({ options, prompt }) => {
    // A real local process and a real production watchdog; transport only is a
    // fixture. This exercises guarded start/stop ordering without a model call.
    child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], env: process.env, cwd, signal: new AbortController().signal });
    void (async () => { for await (const message of prompt) prompts.push(message); })();
    return { async *[Symbol.asyncIterator]() { await outputEnded; }, interrupt: async () => { interrupts++; }, close() { child.kill('SIGTERM'); endOutput(); } };
  },
});
try {
  assert.throws(() => childInputFd({ stdin: {} }), /不兼容/);
  let unsafeFailures = 0;
  const unsafe = guardProcess(process.pid, () => { unsafeFailures++; });
  await assert.rejects(unsafe.ready, /无法建立/); unsafe.dispose();
  assert.equal(unsafeFailures, 1, 'same-group target is refused once without signaling it');
  const old = runtime.startTurn({ runId: 'old', text: 'MUST_NOT_EXECUTE' });
  await actualGuardReady;
  await runtime.interrupt('old');
  assert.equal(prompts.length, 0); assert.equal(interrupts, 0);
  const next = runtime.startTurn({ runId: 'next', text: 'EXPLICIT_NEXT' });
  unlock(); await Promise.all([old, next]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(prompts.map(p => p.message.content), ['EXPLICIT_NEXT']);
  assert(events.some(e => e.type === 'turn.completed' && e.runId === 'old' && e.outcome === 'interrupted'));
  await runtime.close();
  const result = { passed: true, realLocalChild: true, realProductionGuard: true, transport: 'fixture, no CLI/model', delayedGuardReady: true, earlyTurnNotSent: true, nextExplicitTurnOnly: true, interruptRpcCalls: interrupts, unsafeSameGroupRefused: true, missingInputFdRefused: true };
  await mkdir('docs/validation/2026-10-22-crash', { recursive: true }); await writeFile('docs/validation/2026-10-22-crash/early-stop.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { unlock(); await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
