import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist/desktop', { recursive: true });
for (const name of ['main', 'preload', 'host']) {
  await build({ entryPoints: [`apps/desktop/src/${name}.ts`], bundle: true,
    outfile: `dist/desktop/${name}.cjs`, platform: 'node', format: 'cjs', target: 'node24',
    external: ['electron', 'node-pty', 'better-sqlite3', '@anthropic-ai/claude-agent-sdk'], sourcemap: true });
}
await copyFile('docs/architecture/schema.sql', 'dist/desktop/schema.sql');
await viteBuild();
