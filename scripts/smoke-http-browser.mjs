import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import electron from 'electron';
const outputAt = process.argv.indexOf('--output');
const output = resolve(outputAt >= 0 ? process.argv[outputAt + 1] : 'docs/validation/2026-10-22-http/browser.json');
await mkdir(resolve(output, '..'), { recursive: true }); await mkdir('.smoke', { recursive: true });
await build({ entryPoints: ['scripts/smoke-http-browser-main.ts'], outfile: '.smoke/http-browser.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'ws'] });
const home = await mkdtemp(join(tmpdir(), 'xterminal-http-smoke-home-'));
try {
 await new Promise((resolveExit, reject) => {
  const env = { ...process.env, HOME: home, XTERMINAL_HTTP_SMOKE_OUTPUT: output }; delete env.ELECTRON_RUN_AS_NODE; delete env.ZDOTDIR;
  const child = spawn(electron, ['.smoke/http-browser.cjs'], { env, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('HTTP browser smoke timed out')); }, 60000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolveExit() : reject(new Error(`HTTP browser smoke exit ${code}`)); });
 });
 console.log(await readFile(output, 'utf8'));
} finally { await rm(home, { recursive: true, force: true }); }
