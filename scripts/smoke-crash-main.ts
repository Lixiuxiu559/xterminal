import { app, utilityProcess } from 'electron';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
app.whenReady().then(() => {
const host = utilityProcess.fork(resolve('.smoke/crash-host.cjs'));
host.on('message', async message => {
  await writeFile(join(process.env.CRASH_DIRECTORY!, 'message.json'), JSON.stringify(message));
  if (message.type === 'error') app.exit(1);
  if (message.type === 'recovered') setTimeout(() => app.exit(0), 150);
});
host.on('exit', () => { if (process.env.CRASH_PHASE === 'host') app.exit(0); });
host.postMessage({ phase: process.env.CRASH_PHASE === 'recover' ? 'recover' : 'start', directory: process.env.CRASH_DIRECTORY!, schemaPath: resolve('docs/architecture/schema.sql'), nodeExecutable: process.env.CRASH_NODE, codex: process.env.CRASH_CODEX === '1' });

});
