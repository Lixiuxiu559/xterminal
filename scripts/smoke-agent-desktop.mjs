import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import electron from 'electron';
const real = process.argv.includes('--real');
const restrictedPath = process.argv.includes('--restricted-path');
const packageAt = process.argv.indexOf('--package-entry');
const packageEntry = packageAt >= 0 ? process.argv[packageAt + 1] : undefined;
if (packageAt >= 0 && (!packageEntry || packageEntry.startsWith('--'))) throw new Error('--package-entry 需要 app.asar 内 main.cjs 的路径。');
if (restrictedPath && real) throw new Error('受限 PATH 验证仅使用隔离夹具，不调用真实 CLI 或模型。');
const tools = process.argv.includes('--tools');
const modelAt = process.argv.indexOf('--model');
const model = modelAt >= 0 ? process.argv[modelAt + 1] : undefined;
if (real && !model) throw new Error('真实模型测试需显式 --real --model <Codex模型ID>；不会静默选择或重试模型。');
const temporary = await mkdtemp(join(tmpdir(), 'xterminal-agent-desktop-'));
const mode = real ? 'real' : 'fixture';
const outputAt = process.argv.indexOf('--output');
const customOutput = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
if (outputAt >= 0 && (!customOutput || customOutput.startsWith('--'))) throw new Error('--output 需要验证报告目录。');
const output = resolve(customOutput ?? `docs/validation/2026-10-22-agent-desktop/${restrictedPath ? packageEntry ? 'restricted-path-packaged' : 'restricted-path' : mode}`);
await mkdir(output, { recursive: true }); await mkdir('.smoke', { recursive: true });
await mkdir(join(temporary, 'project'), { recursive: true });
await build({ entryPoints: ['scripts/smoke-agent-desktop-main.ts'], outfile: '.smoke/agent-main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'] });
const fixturePath = resolve('scripts/fixtures/agent-desktop-cli.mjs');
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
const fixtureHome = join(temporary, 'home');
const fixtureShell = join(temporary, 'fixture-shell');
const fixtureBin = restrictedPath ? join(fixtureHome, '.nvm', 'versions', 'node', 'v24.0.0', 'bin') : join(temporary, 'bin');
if (!real) {
  await mkdir(fixtureHome, { recursive: true });
  // Preserve the resolver's bounded shell probe, without sourcing any global or user rc.
  await writeFile(fixtureShell, '#!/bin/sh\n[ "$1" = "-ilc" ] || exit 2\nexec /bin/sh -c "$2"\n', { mode: 0o700 });
  await mkdir(fixtureBin, { recursive: true }); await mkdir(join(temporary, 'fixture'));
  // The restricted mode starts Electron with only system PATH: neither CLI nor node
  // is there. Fake nvm installation discovery must recover both; never consult the user's home.
  if (restrictedPath) await symlink(process.execPath, join(fixtureBin, 'node'));
  for (const engine of ['codex', 'claude']) {
    const program = restrictedPath
      ? `#!/usr/bin/env node\nprocess.argv.splice(1, 1, ${JSON.stringify(fixturePath)}, ${JSON.stringify(engine)});\nawait import(${JSON.stringify(pathToFileURL(fixturePath).href)});\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixturePath)} ${engine} "$@"\n`;
    await writeFile(join(fixtureBin, engine), program, { mode: 0o700 });
  }
}
let success = false;
let firstContexts;
try {
  for (const phase of real ? ['first', 'restart'] : ['first', 'restart', 'crash', 'crash-restart']) {
    const env = { ...process.env, XTERMINAL_TEST_DATA: join(temporary, 'data'), XTERMINAL_SMOKE_PROJECT: join(temporary, 'project'), XTERMINAL_SMOKE_OUTPUT: output, XTERMINAL_SMOKE_PHASE: phase, XTERMINAL_AGENT_MODE: mode, XTERMINAL_AGENT_TOOLS: tools ? '1' : '0', XTERMINAL_CODEX_MODEL: model ?? '' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (packageEntry) env.XTERMINAL_SMOKE_PACKAGE_ENTRY = resolve(packageEntry);
    if (!real) {
      env.PATH = restrictedPath ? '/usr/bin:/bin:/usr/sbin:/sbin' : fixtureBin + ':' + env.PATH;
      env.XTERMINAL_AGENT_FIXTURE_ROOT = join(temporary, 'fixture');
      env.HOME = fixtureHome; env.SHELL = fixtureShell;
      for (const key of ['XTERMINAL_CLAUDE_PATH', 'XTERMINAL_CODEX_PATH', 'NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ZDOTDIR']) delete env[key];
    }
    await new Promise((resolveExit, reject) => {
      const child = spawn(electron, ['.smoke/agent-main.cjs'], { env, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Agent desktop ${mode}/${phase} timed out`)); }, real ? 300000 : 120000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`Agent desktop ${mode}/${phase}: exit ${code}`)); });
    });
    const report = JSON.parse(await readFile(join(output, `${phase}.json`), 'utf8'));
    assert.equal(report.passed, true);
    report.environment = { restrictedPath, packagedEntry: !!packageEntry, isolatedHome: !real, fixtureCliUsesEnvNode: restrictedPath };
    const database = new DatabaseSync(join(temporary, 'data', 'xterminal.sqlite'), { readOnly: true });
    try {
      const contexts = database.prepare('SELECT session_id, native_context_id FROM engine_contexts ORDER BY session_id').all();
      assert.equal(contexts.length, 2); assert.ok(contexts.every(context => context.native_context_id));
      if (phase === 'first') firstContexts = contexts;
      else assert.deepEqual(contexts, firstContexts, '明确恢复同一原生上下文，而非创建新上下文');
      const active = database.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('starting','running','waiting','stopping')").get();
      assert.equal(active.n, phase === 'crash' ? 1 : 0);
      report.database = { contextsSaved: true, sameNativeContextAfterRestart: phase !== 'first', noActiveRunsAfterExit: phase !== 'crash',
        runs: database.prepare('SELECT status, count(*) AS count FROM runs GROUP BY status').all(),
        receipts: database.prepare('SELECT state, count(*) AS count FROM command_receipts GROUP BY state').all() };
    } finally { database.close(); }
    if (!real) {
      // The fixture log has only this test's metadata and prompts, never account/auth data.
      const frames = (await readFile(join(temporary, 'fixture', 'metadata.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      await writeFile(join(output, 'protocol-metadata.json'), JSON.stringify(frames, null, 2));
      report.fixtureProcesses = [...new Set(frames.filter(frame => Number.isSafeInteger(frame.pid)).map(frame => frame.pid))].length;
    }
    await writeFile(join(output, `${phase}.json`), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
  success = true;
} finally {
  if (success) await rm(temporary, { recursive: true, force: true });
  else console.error(`Failed Agent desktop data retained at ${temporary}`);
}
