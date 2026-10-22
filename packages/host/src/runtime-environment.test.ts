import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { resolveEngineTargets } from './engine-environment.ts';
import { CodexRuntime, detectCodex, listCodexModels } from '../../engines/codex/src/runtime.ts';
import { ClaudeRuntime, detectClaude } from '../../engines/claude/src/runtime.ts';
import type { AgentEngineEvent, AgentRuntime } from '../../protocol/src/agent.ts';

test('real fixture subprocesses use the resolved PATH/env for detection, model listing and both Runtime transports', { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'xterminal-runtime-env-')); const bin = join(home, '.nvm/versions/node/v24.0.0/bin');
  const fixture = pathToFileURL(resolve('scripts/fixtures/agent-desktop-cli.mjs')).href;
  const runtimes: AgentRuntime[] = [];
  try {
    mkdirSync(bin, { recursive: true }); symlinkSync(process.execPath, join(bin, 'node'));
    for (const engine of ['claude', 'codex']) writeFileSync(join(bin, engine), `#!/usr/bin/env node\nprocess.argv.splice(2, 0, ${JSON.stringify(engine)}); await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
    const targets = await resolveEngineTargets({ shell: '/missing', home, env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', XTERMINAL_AGENT_FIXTURE_ROOT: home } });
    assert.equal((await detectCodex(targets.codex.path!, { env: targets.codex.env })).available, true);
    assert.equal((await detectClaude(targets.claude.path!, { env: targets.claude.env })).available, true);
    assert.equal((await listCodexModels(targets.codex.path!, targets.codex.env))[0].id, 'e2e-codex-model');
    for (const engine of ['claude', 'codex'] as const) {
      let resolveDone!: (event: AgentEngineEvent) => void;
      const done = new Promise<AgentEngineEvent>(resolve => { resolveDone = resolve; });
      const target = targets[engine];
      const options = { cwd: home, nativeContextId: null, executablePath: target.path!, env: target.env, onEvent: (event: AgentEngineEvent) => { if (event.type === 'turn.completed') resolveDone(event); } };
      const runtime = engine === 'claude' ? new ClaudeRuntime(options) : new CodexRuntime(options); runtimes.push(runtime);
      await runtime.startTurn({ runId: `fixture-${engine}`, text: 'E2E_MESSAGE:environment' });
      const event = await done; assert.equal(event.type, 'turn.completed'); if (event.type === 'turn.completed') assert.equal(event.outcome, 'completed');
      await runtime.close();
    }
    const metadata = readFileSync(join(home, 'metadata.jsonl'), 'utf8');
    assert.match(metadata, /model\/list/); assert.match(metadata, /session.start/); assert.match(metadata, /turn.start/);
  } finally { await Promise.all(runtimes.map(runtime => runtime.close())); rmSync(home, { recursive: true, force: true }); }
});
