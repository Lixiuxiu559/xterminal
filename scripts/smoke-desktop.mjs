import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import electron from 'electron';
const temporary = await mkdtemp(join(tmpdir(), 'xterminal-desktop-smoke-'));
const packaged = process.argv.includes('--packaged');
const output = resolve(`docs/validation/2026-10-22-desktop${packaged ? '-packaged' : ''}`);
await mkdir(output, { recursive: true });
await mkdir('.smoke', { recursive: true });
await build({ entryPoints: ['scripts/smoke-desktop-main.ts'], outfile: '.smoke/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
await build({ entryPoints: ['scripts/smoke-shell-host.ts'], outfile: '.smoke/shell.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'node-pty'], target: 'node24' });
let success = false;
try {
  for (const phase of ['first', 'restart']) {
    const env = { ...process.env, XTERMINAL_SMOKE: '1', XTERMINAL_TEST_DATA: join(temporary, 'data'), XTERMINAL_SMOKE_PROJECT: join(temporary, 'project'), XTERMINAL_SMOKE_OUTPUT: output, XTERMINAL_SMOKE_PHASE: phase };
    delete env.ELECTRON_RUN_AS_NODE;
    if (packaged) env.XTERMINAL_SMOKE_PACKAGE_ENTRY = resolve('release/mac-arm64/XTerminal.app/Contents/Resources/app.asar/dist/desktop/main.cjs');
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
