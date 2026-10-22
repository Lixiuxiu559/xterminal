import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, opendirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type ExecutableSource = 'override' | 'path' | 'login-shell' | 'known-location';
export interface ExecutableResolution {
  path: string | null;
  source: ExecutableSource | null;
  failure: 'not-found' | 'invalid-override' | null;
}
export function isExecutableFile(path: string): boolean {
  try { return isAbsolute(path) && statSync(path).isFile() && (accessSync(path, constants.X_OK), true); } catch { return false; }
}
export function pathDirectories(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(delimiter).filter(part => isAbsolute(part) && !/[\0\r\n]/.test(part)))].slice(0, 256);
}
export function findExecutable(name: string, directories: string[]): string | null {
  if (!/^[a-z][a-z0-9._-]*$/i.test(name)) throw new TypeError('无效的可执行文件名');
  for (const directory of directories.slice(0, 256)) {
    const candidate = join(directory, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}
function versions(root: string): string[] {
  const names: string[] = [];
  try {
    const directory = opendirSync(root);
    try {
      for (let count = 0; count < 256; count++) {
        const entry = directory.readSync(); if (!entry) break;
        if (entry.isDirectory() && /^v?\d+\.\d+\.\d+$/.test(entry.name)) names.push(entry.name);
      }
    } finally { directory.closeSync(); }
  } catch { /* unavailable manager directory */ }
  return names.sort((a, b) => {
    const left = a.replace(/^v/, '').split('.').map(Number); const right = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return right[i] - left[i]; }
    return 0;
  }).slice(0, 32).map(name => join(root, name));
}
export function knownBinDirectories(home: string, platform = process.platform): string[] {
  const nvm = join(home, '.nvm', 'versions', 'node');
  const fnm = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'fnm', 'node-versions') : join(home, '.local', 'share', 'fnm', 'node-versions');
  return [...versions(nvm).map(root => join(root, 'bin')), ...versions(fnm).map(root => join(root, 'installation', 'bin')),
    join(home, '.volta', 'bin'), join(home, '.asdf', 'shims'), join(home, 'Library', 'pnpm'), join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
}
export function resolveExecutable(options: { name: string; home: string; override?: string; path?: string; loginPath?: string | null; knownDirectories: string[] }): ExecutableResolution {
  if (options.override !== undefined) {
    const configured = options.override.startsWith('~/') ? join(options.home, options.override.slice(2)) : options.override;
    return isExecutableFile(configured) ? { path: configured, source: 'override', failure: null } : { path: null, source: null, failure: 'invalid-override' };
  }
  const sources = [['path', pathDirectories(options.path)], ['login-shell', pathDirectories(options.loginPath ?? undefined)], ['known-location', options.knownDirectories]] as const;
  for (const [source, directories] of sources) {
    const path = findExecutable(options.name, [...directories]); if (path) return { path, source, failure: null };
  }
  return { path: null, source: null, failure: 'not-found' };
}
/** Only PATH is recovered; shell startup output and other exports never escape this function. */
export function resolveLoginShellPath(options: { shell: string; home: string; env: Record<string, string | undefined>; timeoutMs?: number }): Promise<string | null> {
  if (!isExecutableFile(options.shell) || !isAbsolute(options.home)) return Promise.resolve(null);
  const marker = `XTERMINAL_PATH_${randomUUID().replaceAll('-', '')}`;
  return new Promise(resolve => {
    let settled = false; let output = ''; let outputBytes = 0;
    const finish = (value: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const child = spawn(options.shell, ['-ilc', `printf '\\n${marker}\\n%s\\n${marker}\\n' "$PATH"`], {
      cwd: options.home, env: { ...options.env, HOME: options.home }, stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, detached: process.platform !== 'win32',
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 65_536) { killProbe(); finish(null); return; }
      output += chunk;
    });
    child.stderr.resume();
    child.once('error', () => finish(null));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { finish(null); return; }
      const lines = output.split('\n'); const start = lines.indexOf(marker);
      if (start < 0 || lines[start + 2] !== marker) { finish(null); return; }
      const directories = pathDirectories(lines[start + 1]); finish(directories.length ? directories.join(delimiter) : null);
    });
    // Bound readiness even when a shell startup descendant keeps a pipe open.
    const killProbe = () => {
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ } }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { killProbe(); finish(null); }, options.timeoutMs ?? 3000);
    timer.unref();
  });
}
