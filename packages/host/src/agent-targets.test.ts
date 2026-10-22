import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../storage/src/store.ts';
import { AgentSessions } from './agents.ts';
import { isolatedEngineTargets } from './engine-environment.ts';
import type { AgentRuntimeOptions } from '../../protocol/src/agent.ts';
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'xterminal-agent-targets-'));
  const store = new Store(join(home, 'state.sqlite'), resolve('docs/architecture/schema.sql'), path => new DatabaseSync(path));
  const project = store.addProject(home); const session = store.createSession({ id: 'fixture-session', projectId: project.id, engine: 'codex', title: 'fixture' });
  return { home, store, session, dispose: () => { store.close(); rmSync(home, { recursive: true, force: true }); } };
}
test('T4 detect, models and start share one target/env snapshot; explicit locator only runs once', async () => {
  const f = fixture(); const targets = isolatedEngineTargets(); targets.codex = { path: join(f.home, 'codex'), source: 'override', failure: null, env: { PATH: f.home, TARGET_CANARY: 'same' } };
  let locateCalls = 0; let runtimeOptions: AgentRuntimeOptions | undefined;
  const agents = new AgentSessions({ store: f.store, instanceId: 'instance', state: () => {}, catalog: () => {}, emit: () => {} }, {
    locate: async () => { locateCalls++; return targets; },
    detect: async value => { assert.equal(value, targets); return [{ engine: 'codex', available: true, version: 'fixture', reason: null }]; },
    listModels: async value => { assert.equal(value, targets.codex); return [{ id: 'fixture', label: 'Fixture', isDefault: true }]; },
    createRuntime: (_engine, options) => { runtimeOptions = options; return { engine: 'codex', startTurn: async () => {}, respond: async () => {}, interrupt: async () => {}, close: async () => { options.onEvent({ type: 'process.exited', runId: null, error: 'fixture closed' }); } }; },
  });
  try {
    await agents.initialize(); assert.equal((await agents.models())[0].id, 'fixture'); agents.start(f.session.id, 'hello', 'command');
    assert.equal(locateCalls, 1); assert.equal(runtimeOptions!.executablePath, targets.codex.path); assert.deepEqual(runtimeOptions!.env, targets.codex.env);
    assert.notEqual(runtimeOptions!.env, targets.codex.env);
    await agents.close();
  } finally { f.dispose(); }
});
test('T7 injected detect with no locator never executes configured shell or inspects real CLI', async () => {
  const f = fixture(); const marker = join(f.home, 'shell-ran'); const shell = join(f.home, 'shell');
  writeFileSync(shell, `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  let detected = false;
  const agents = new AgentSessions({ store: f.store, instanceId: 'instance', shell, state: () => {}, catalog: () => {}, emit: () => {} }, {
    detect: async targets => { detected = true; assert.deepEqual(targets, isolatedEngineTargets()); return []; },
  });
  try { await agents.initialize(); assert.equal(detected, true); assert.equal(existsSync(marker), false); await agents.close(); }
  finally { f.dispose(); }
});
