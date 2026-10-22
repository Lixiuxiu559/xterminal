import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
// Execute against the packaged Electron runtime and unpacked native modules.
// This checks ABI/resource paths, and does not replace packaged UI testing.
const binary = resolve('release/mac-arm64/XTerminal.app/Contents/MacOS/XTerminal');
const resources = resolve('release/mac-arm64/XTerminal.app/Contents/Resources/app.asar');
const code = `const root=${JSON.stringify(resources)}; const Database=require(root+'/node_modules/better-sqlite3'); const db=new Database(':memory:'); db.exec('CREATE TABLE smoke(x INTEGER)'); db.prepare('INSERT INTO smoke VALUES (?)').run(42); if(db.prepare('SELECT x FROM smoke').get().x!==42) throw Error('SQLite'); db.close(); const pty=require(root+'/node_modules/node-pty'); const terminal=pty.spawn('/bin/sh',['-c','printf packaged-native-ok'],{name:'xterm-256color',cols:80,rows:24,cwd:'/private/tmp',env:{PATH:'/usr/bin:/bin'}}); let output=''; terminal.onData(data=>output+=data); terminal.onExit(({exitCode})=>{if(exitCode!==0||!output.includes('packaged-native-ok'))process.exit(1);console.log(JSON.stringify({sqlite:true,pty:true,exitCode,node:process.versions.node,electron:process.versions.electron}));});setTimeout(()=>process.exit(2),5000).unref();`;
let result = '';
await new Promise((res, rej) => {
  const child = spawn(binary, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { result += data; process.stdout.write(data); });
  child.stderr.on('data', data => process.stderr.write(data));
  child.once('error', rej);
  child.once('exit', code => code === 0 ? res() : rej(new Error(`Native package check failed: ${code}`)));
});
await writeFile('docs/validation/2026-10-22-desktop/packaged-native.json', result);
