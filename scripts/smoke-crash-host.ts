import { join } from 'node:path';
import { Store } from '../packages/storage/src/store.ts';
import { SessionHost } from '../packages/host/src/controller.ts';
import { CodexRuntime } from '../packages/engines/codex/src/runtime.ts';
import { spawn } from 'node:child_process';
import { childInputFd, guardProcess } from '../packages/engines/shared/src/process-guard.ts';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const port = process.parentPort!;
port.on('message', async ({ data }) => {
  try {
    const { phase, directory, schemaPath, nodeExecutable, codex } = data;
    const store = new Store(join(directory, 'xterminal.sqlite'), schemaPath);
    const host = new SessionHost({ dbPath: join(directory, 'xterminal.sqlite'), schemaPath, shell: '/bin/zsh', emit: () => {} }, { store });
    await host.ready();
    if (phase === 'recover') {
      const old = store.getSetting<{ sessionId: string; commandId: string; text: string }>('crash.input')!;
      const acquired = await host.handle({ id: randomUUID(), method: 'control.acquire', params: { sessionId: old.sessionId } });
      if (!acquired.ok) throw new Error(acquired.error.message);
      const lease = host.bootstrap().sessions.find(s => s.id === old.sessionId)!.control!;
      const replay = await host.handle({ id: randomUUID(), method: 'agent.turn.start', control: { hostInstanceId: lease.hostInstanceId, generation: lease.generation }, params: { sessionId: old.sessionId, commandId: old.commandId, text: old.text } });
      const replayCode = replay.ok ? null : replay.error.code;
      port.postMessage({ type: 'recovered', snapshot: host.bootstrap(), messages: store.listAgentMessages(old.sessionId), replayCode, activeCount: host.activeCount() });
      await host.close(); return;
    }
    const project = host.addProject(directory);
    const shellId = randomUUID();
    await host.handle({ id: randomUUID(), method: 'session.create', params: { projectId: project.id, engine: 'shell', title: 'Crash Shell', commandId: shellId } });
    const lease = host.bootstrap().sessions.find(s => s.id === shellId)!.control!;
    const control = { hostInstanceId: lease.hostInstanceId, generation: lease.generation };
    const start = await host.handle({ id: randomUUID(), method: 'shell.start', params: { sessionId: shellId, cols: 80, rows: 24 }, control });
    if (!start.ok) throw new Error(start.error.message);
    const snapshot = await host.handle({ id: randomUUID(), method: 'shell.snapshot', params: { sessionId: shellId } });
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    const terminal = snapshot.result as { runId: string; terminalEpoch: string };
    const program = 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});require("fs").writeFileSync("worker.pid",String(process.pid));setInterval(()=>{},1000)';
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    await host.handle({ id: randomUUID(), method: 'shell.input', control, params: { sessionId: shellId, runId: terminal.runId, terminalEpoch: terminal.terminalEpoch, inputId: randomUUID(), data: `${quote(nodeExecutable)} -e ${quote(program)}\r` } });
    let worker = 0;
    for (let i = 0; i < 100; i++) { try { worker = Number(await readFile(join(directory, 'worker.pid'), 'utf8')); if (worker) break; } catch {} await new Promise(r => setTimeout(r, 30)); }
    if (!worker) throw new Error('real Shell worker did not start');
    // Database fault boundary, not a fabricated successful Agent/model turn.
    const sessionId = randomUUID(), commandId = randomUUID(), runId = randomUUID(), text = 'UNSENT_RECOVERY_BOUNDARY';
    store.createSession({ id: sessionId, projectId: project.id, engine: 'codex', title: 'Recovery boundary' });
    store.acceptAgentTurn({ sessionId, commandId, runId, text, hostInstanceId: host.instanceId });
    store.markDispatched(sessionId, commandId);
    store.saveAgentMessage(sessionId, { id: randomUUID(), runId, role: 'assistant', text: 'persisted partial boundary', status: 'streaming', createdAt: new Date().toISOString() });
    store.setSetting('crash.input', { sessionId, commandId, text });
    // Real controlled stdio process: EOF immediately exits the root while its
    // tool ignores HUP/TERM. The inherited write FD must prevent the EOF race.
    const workerProgram = 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});require("fs").writeFileSync("agent-worker.pid",String(process.pid));setInterval(()=>{},1000)';
    const fixtureProgram = `const cp=require('child_process'); const w=cp.spawn(process.execPath,['-e',${JSON.stringify(workerProgram)}],{stdio:'ignore'}); const fs=require('fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync('agent-eof.txt','EOF');process.exit(0)});setInterval(()=>{},1000);`;
    const agentFixture = spawn(nodeExecutable, ['-e', fixtureProgram], { cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const fixtureGuard = guardProcess(agentFixture.pid!, error => { throw error; }, childInputFd(agentFixture));
    agentFixture.once('exit', () => fixtureGuard.dispose());
    await fixtureGuard.ready;
    let agentWorkerPid = 0;
    for (let i=0;i<100;i++) { try { agentWorkerPid=Number(await readFile(join(directory,'agent-worker.pid'),'utf8')); if(agentWorkerPid)break; } catch {} await new Promise(r=>setTimeout(r,20)); }
    if(!agentWorkerPid)throw new Error('real stdio worker did not start');
    let codexContext = false;
    if (codex) { const runtime = new CodexRuntime({ cwd: directory, nativeContextId: null, onEvent: () => {} }); await runtime.initialize(); codexContext = true; }
    port.postMessage({ type: 'ready', hostPid: process.pid, workerPid: worker, agentFixturePid: agentFixture.pid, agentWorkerPid, shellId, agentId: sessionId, codexContext });
  } catch (error) { port.postMessage({ type: 'error', message: (error as Error).stack }); }
});
