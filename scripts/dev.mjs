import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import electron from 'electron';
await mkdir('dist/desktop', { recursive: true });
for (const name of ['main', 'preload', 'host']) {
  await build({ entryPoints: [`apps/desktop/src/${name}.ts`], bundle: true,
    outfile: `dist/desktop/${name}.cjs`, platform: 'node', format: 'cjs', target: 'node24',
    external: ['electron', 'node-pty', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'], sourcemap: true });
}
await copyFile('docs/architecture/schema.sql', 'dist/desktop/schema.sql');
const server = await createServer();
await server.listen();
const env = { ...process.env, XTERMINAL_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { env, stdio: 'inherit' });
let closing = false;
async function close() { if (closing) return; closing = true; child.kill(); await server.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, close);
child.once('exit', async code => { await server.close(); process.exitCode = code ?? 1; });
