import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { knownBinDirectories, pathDirectories, resolveExecutable, resolveLoginShellPath } from './executable.ts';

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'xterminal-executable-')));
  const script = (path: string, body = '#!/bin/sh\nexit 0\n') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body, { mode: 0o700 }); return path; };
  return { home, script, dispose: () => rmSync(home, { recursive: true, force: true }) };
}
test('absolute PATH precedes login shell and manager bins; ignores relative/empty/NUL entries', () => {
  const f = fixture(); try {
    const first = f.script(join(f.home, 'first bin', 'codex')); const second = f.script(join(f.home, 'second', 'codex'));
    const result = resolveExecutable({ name: 'codex', home: f.home, path: ['', '.', 'relative', join(f.home, 'first bin')].join(delimiter), loginPath: join(second, '..'), knownDirectories: [] });
    assert.equal(result.path, first); assert.equal(result.source, 'path');
    assert.deepEqual(pathDirectories(':.:relative:/tmp\0bad:/tmp'), ['/tmp']);
  } finally { f.dispose(); }
});
test('known nvm/fnm locations sort versions numerically; override supports spaces/symlinks and never silently falls back', () => {
  const f = fixture(); try {
    f.script(join(f.home, '.nvm/versions/node/v9.0.0/bin/codex'));
    const newest = f.script(join(f.home, '.nvm/versions/node/v24.0.0/bin/codex'));
    const dirs = knownBinDirectories(f.home).filter(path => path.startsWith(f.home));
    const result = resolveExecutable({ name: 'codex', home: f.home, path: '', knownDirectories: dirs });
    assert.equal(result.path, newest); assert.equal(result.source, 'known-location');
    const link = join(f.home, 'space link'); symlinkSync(newest, link);
    assert.equal(resolveExecutable({ name: 'codex', home: f.home, override: '~/space link', knownDirectories: dirs }).path, link);
    for (const override of ['', '.', join(f.home, 'missing'), f.home]) assert.equal(resolveExecutable({ name: 'codex', home: f.home, override, path: join(newest, '..'), knownDirectories: dirs }).failure, 'invalid-override');
    const fnm = f.script(join(f.home, 'Library/Application Support/fnm/node-versions/v22.1.0/installation/bin/claude'));
    assert.equal(resolveExecutable({ name: 'claude', home: f.home, knownDirectories: knownBinDirectories(f.home) }).path, fnm);
  } finally { f.dispose(); }
});
test('login shell extracts marked PATH amid stdout/stderr noise and uses home cwd', async () => {
  const f = fixture(); try {
    const bin = join(f.home, 'login bin'); mkdirSync(bin);
    const shell = f.script(join(f.home, 'shell'), `#!/bin/sh\nprintf 'private prelude\\n'\nprintf 'private stderr\\n' >&2\n[ "$PWD" = "$HOME" ] || exit 9\nPATH=${JSON.stringify(bin)}\neval "$2"\nprintf 'private suffix\\n'\n`);
    const value = await resolveLoginShellPath({ shell, home: f.home, env: { HOME: '/wrong', PATH: '/usr/bin' } });
    assert.equal(value, bin); assert.doesNotMatch(JSON.stringify(value), /private (prelude|stderr|suffix)/);
    const executable = f.script(join(bin, 'claude'));
    assert.equal(resolveExecutable({ name: 'claude', home: f.home, path: '', loginPath: value, knownDirectories: [] }).path, executable);
  } finally { f.dispose(); }
});
test('login shell failures, oversized output, invalid PATH and timeout degrade without exposing output', async () => {
  const f = fixture(); try {
    for (const body of ['exit 3', 'PATH=relative; eval "$2"', "printf 'secret without markers\\n'", "while :; do printf 'secret-noise-secret-noise-secret-noise'; done", 'exec /bin/sleep 3']) {
      const shell = f.script(join(f.home, 'shell'), `#!/bin/sh\n${body}\n`);
      const started = Date.now();
      assert.equal(await resolveLoginShellPath({ shell, home: f.home, env: {}, timeoutMs: 60 }), null);
      assert.ok(Date.now() - started < 1500);
    }
  } finally { f.dispose(); }
});
