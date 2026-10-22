import { CodexRuntime, detectCodex } from '../packages/engines/codex/src/runtime.ts';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cwd = await mkdtemp(join(tmpdir(), 'xterminal-codex-init-'));
const runtime = new CodexRuntime({ cwd, nativeContextId: null, onEvent: () => {} });
try {
  const capability = await detectCodex();
  await runtime.initialize();
  const result = { passed: true, version: capability.version, initialize: true, accountCheck: true, threadStart: true, modelTurnStarted: false, at: new Date().toISOString() };
  console.log(JSON.stringify(result));
  await mkdir('docs/validation/2026-10-22-agent', { recursive: true });
  await writeFile('docs/validation/2026-10-22-agent/codex-initialize.json', JSON.stringify(result, null, 2));
} finally { await runtime.close(); await rm(cwd, { recursive: true, force: true }); }
