import { openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname } from 'node:path';
import type { AgentEnvironment } from '../../protocol/src/agent.ts';
import { findExecutable, knownBinDirectories, pathDirectories, resolveExecutable, resolveLoginShellPath, type ExecutableResolution } from '../../engines/shared/src/executable.ts';

export interface EngineTarget extends ExecutableResolution { env: AgentEnvironment }
export interface EngineTargets { claude: EngineTarget; codex: EngineTarget }
/** Empty targets for injected fixture services: never inspect the real home or execute a shell. */
export function isolatedEngineTargets(): EngineTargets {
  const target = (): EngineTarget => ({ path: null, source: null, failure: 'not-found', env: { PATH: '' } });
  return { claude: target(), codex: target() };
}
function needsNode(path: string): boolean {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); const buffer = Buffer.alloc(256); const size = readSync(fd, buffer, 0, 256, 0); return /^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?node(?:\s|$)/.test(buffer.subarray(0, size).toString()); }
  catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
export async function resolveEngineTargets(options: { shell?: string; home?: string; env?: AgentEnvironment; timeoutMs?: number } = {}): Promise<EngineTargets> {
  const env = { ...(options.env ?? process.env) }; const home = options.home ?? env.HOME ?? homedir();
  const loginPath = await resolveLoginShellPath({ shell: options.shell ?? env.SHELL ?? '/bin/zsh', home, env, timeoutMs: options.timeoutMs });
  const knownDirectories = knownBinDirectories(home);
  const base = [...new Set([...pathDirectories(env.PATH), ...pathDirectories(loginPath ?? undefined)])];
  const target = (name: 'claude' | 'codex'): EngineTarget => {
    const resolution = resolveExecutable({ name, home, override: env[`XTERMINAL_${name.toUpperCase()}_PATH`], path: env.PATH, loginPath, knownDirectories });
    let directories = [...base];
    if (resolution.path) {
      const bin = dirname(resolution.path);
      if (needsNode(resolution.path) && !findExecutable('node', directories)) {
        const node = findExecutable('node', [bin, ...knownDirectories]);
        if (node) directories.push(dirname(node));
      }
      directories.push(bin);
    }
    return { ...resolution, env: { ...env, PATH: [...new Set(directories)].join(delimiter) } };
  };
  return { claude: target('claude'), codex: target('codex') };
}
export function missingEngineReason(engine: 'claude' | 'codex', target: EngineTarget): string {
  const name = engine === 'claude' ? 'Claude Code' : 'Codex';
  return target.failure === 'invalid-override'
    ? `XTERMINAL_${engine.toUpperCase()}_PATH 配置无效，请指定可执行文件的绝对路径并重启应用。`
    : `未找到可执行的 ${name} CLI。已检查应用 PATH、登录 Shell 和常见安装目录；请检查官方 CLI 安装后明确退出并重启应用。`;
}
