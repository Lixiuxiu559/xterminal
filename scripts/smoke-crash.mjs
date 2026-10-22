import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import electron from 'electron';
const directory = await mkdtemp(join(tmpdir(), 'xterminal-crash-'));
const output = resolve('docs/validation/2026-10-22-crash');
await mkdir(output, { recursive: true }); await mkdir('.smoke', { recursive: true });
for (const name of ['main', 'host']) await build({ entryPoints: [`scripts/smoke-crash-${name}.ts`], outfile: `.smoke/crash-${name}.cjs`, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'], target: 'node24' });
const canary = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(operation, label, ms = 30000) { const deadline = Date.now() + ms; for (;;) { const value = await operation(); if (value) return value; if (Date.now() > deadline) throw new Error(`timeout: ${label}`); await new Promise(r => setTimeout(r, 30)); } }
let success = false; const owned = [];
try {
 for (const phase of ['host', 'application']) {
  const current = join(directory, phase); await mkdir(current);
  const env = { ...process.env, CRASH_DIRECTORY: current, CRASH_PHASE: phase, CRASH_NODE: process.execPath, CRASH_CODEX: process.argv.includes('--codex') ? '1' : '0' }; delete env.ELECTRON_RUN_AS_NODE;
  const application = spawn(electron, ['.smoke/crash-main.cjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  owned.push(application.pid);
  let diagnostics = ''; application.stderr.on('data', b => diagnostics += String(b));
  const ready = await until(async () => { try { const m = JSON.parse(await readFile(join(current, 'message.json'), 'utf8')); if (m.type === 'error') throw new Error(m.message); return m.type === 'ready' ? m : null; } catch(e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; } }, `${phase} ready`);
  owned.push(ready.hostPid, ready.workerPid);
  // This is a process table of test-created children only, no environment/command dump.
  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const descendants = new Set([ready.hostPid]);
  for (let pass = 0; pass < processRows.length; pass++) { let changed = false; for (const row of processRows) { const [pid, ppid] = row.trim().split(/\s+/).map(Number); if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; } } if (!changed) break; }
  const processesBefore = processRows.filter(line => descendants.has(Number(line.trim().split(/\s+/)[0])));
  if (phase === 'application') application.kill('SIGKILL'); else process.kill(ready.hostPid, 'SIGKILL');
  await until(() => !alive(ready.hostPid), `${phase} Host exits`);
  await until(() => !alive(ready.workerPid), `${phase} HUP/TERM-resistant child exits`);
  await until(() => [...descendants].every(pid => !alive(pid)), `${phase} owned engines and watchdogs exit`);
  let unexpectedEof = false; try { await readFile(join(current, 'agent-eof.txt')); unexpectedEof = true; } catch(e) { if(e.code !== 'ENOENT') throw e; }
  assert.equal(unexpectedEof, false, 'guard must retain Agent stdin until cleanup rather than let root exit on Host EOF');
  assert(alive(canary.pid), 'unrelated process must survive');
  await rm(join(current, 'message.json'));
  const recovery = spawn(electron, ['.smoke/crash-main.cjs'], { env: { ...env, CRASH_PHASE: 'recover' }, stdio: 'inherit' });
  await new Promise((res, rej) => { const timer = setTimeout(() => { recovery.kill('SIGKILL'); rej(new Error('recovery timeout')); }, 15000); recovery.once('exit', code => { clearTimeout(timer); code === 0 ? res() : rej(new Error(`recovery exited ${code}`)); }); });
  const recovered = JSON.parse(await readFile(join(current, 'message.json'), 'utf8'));
  assert.equal(recovered.type, 'recovered'); assert.equal(recovered.activeCount, 0);
  assert(recovered.snapshot.sessions.every(s => s.state === 'interrupted'));
  assert(recovered.messages.filter(m => m.role === 'assistant').every(m => m.status === 'interrupted'));
  assert.equal(recovered.messages.length, 2);
  assert.equal(recovered.replayCode, 'COMMAND_OUTCOME_UNKNOWN');
  const result = { phase, realElectronUtility: true, realPty: true, controlledStdioToolReaped: true, preventedEarlyAgentStdinEof: true, codexInitializeWithoutModel: ready.codexContext, interruptedRuns: recovered.snapshot.sessions.length, interruptedPartialMessages: 1, replayCode: recovered.replayCode, activeCount: recovered.activeCount, canarySurvived: true, descendantProcessesReaped: descendants.size, processesBefore, diagnostics: diagnostics.slice(-500) };
  await writeFile(join(output, `${phase}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
 }
 success = true;
} finally {
 // Never sweep arbitrary process names or persisted PID files. This canary is a
 // direct child whose ChildProcess object retains its original process identity.
 canary.kill('SIGKILL');
 if (success) await rm(directory, { recursive: true, force: true });
 else console.error(`Crash evidence/data retained: ${directory}; owned PIDs: ${owned.join(', ')}`);
}
