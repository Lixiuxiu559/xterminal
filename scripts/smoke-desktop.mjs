import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import electron from 'electron';
const temporary = await mkdtemp(join(tmpdir(), 'xterminal-desktop-smoke-'));
const packageAt = process.argv.indexOf('--package-entry');
const packageEntry = packageAt >= 0 ? process.argv[packageAt + 1] : undefined;
if (packageAt >= 0 && (!packageEntry || packageEntry.startsWith('--'))) throw new Error('--package-entry 需要包内 main.cjs 路径。');
const packaged = process.argv.includes('--packaged') || !!packageEntry;
const outputAt = process.argv.indexOf('--output');
const customOutput = outputAt >= 0 ? process.argv[outputAt + 1] : undefined;
if (outputAt >= 0 && (!customOutput || customOutput.startsWith('--'))) throw new Error('--output 需要验证报告目录。');
const output = resolve(customOutput ?? `docs/validation/2026-10-22-desktop${packaged ? '-packaged' : ''}`);
await mkdir(output, { recursive: true });
await mkdir('.smoke', { recursive: true });
await build({ entryPoints: ['scripts/smoke-desktop-main.ts'], outfile: '.smoke/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['scripts/smoke-shell-host.ts'], outfile: '.smoke/shell.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty'], target: 'node24' });
let success = false;
try {
  for (const phase of ['first', 'restart']) {
    const env = { ...process.env, HOME: join(temporary, 'home'), SHELL: '/bin/zsh', XTERMINAL_CLAUDE_PATH: join(temporary, 'missing-claude'), XTERMINAL_CODEX_PATH: join(temporary, 'missing-codex'), XTERMINAL_SMOKE: '1', XTERMINAL_TEST_DATA: join(temporary, 'data'), XTERMINAL_SMOKE_PROJECT: join(temporary, 'project'), XTERMINAL_SMOKE_OUTPUT: output, XTERMINAL_SMOKE_PHASE: phase };
    delete env.ZDOTDIR;
    await mkdir(env.HOME, { recursive: true });
    delete env.ELECTRON_RUN_AS_NODE;
    if (packaged) env.XTERMINAL_SMOKE_PACKAGE_ENTRY = resolve(packageEntry ?? 'release/mac-arm64/XTerminal.app/Contents/Resources/app.asar/dist/desktop/main.cjs');
    await mkdir(env.XTERMINAL_SMOKE_PROJECT, { recursive: true });
    await new Promise((res, rej) => {
      const child = spawn(electron, ['.smoke/main.cjs'], { env, stdio: 'inherit' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error(`Electron smoke ${phase} timed out`)); }, 90_000);
      child.once('error', error => { clearTimeout(timer); rej(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? res() : rej(new Error(`Electron smoke ${phase}: exit ${code}`)); });
    });
    console.log(await readFile(join(output, `${phase}.json`), 'utf8'));
  }
  success = true;
} finally {
  if (success) await rm(temporary, { recursive: true, force: true });
  else console.error(`Failed smoke data retained at ${temporary}`);
}
