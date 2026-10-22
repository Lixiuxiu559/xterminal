import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveEngineTargets, missingEngineReason } from './engine-environment.ts';
import { detectCodex } from '../../engines/codex/src/runtime.ts';
import { detectClaude } from '../../engines/claude/src/runtime.ts';

test('minimal GUI PATH resolves manager CLI and env-node interpreter without mutating process.env', async () => {
  const home = mkdtempSync(join(tmpdir(), 'xterminal-engine-env-')); const oldPath = process.env.PATH;
  try {
    const bin = join(home, '.nvm/versions/node/v24.0.0/bin'); mkdirSync(bin, { recursive: true }); symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\nconsole.log("codex-cli 0.157.0");\n', { mode: 0o700 });
    writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? '2.1.304 (Claude Code)' : JSON.stringify({loggedIn:true}));\n`, { mode: 0o700 });
    const env = { HOME: home, PATH: '/usr/bin:/bin', PRIVATE_CANARY: 'preserved' };
    const targets = await resolveEngineTargets({ home, env, shell: '/missing' });
    assert.equal(targets.codex.source, 'known-location'); assert.equal(targets.codex.path, join(bin, 'codex'));
    assert.equal(execFileSync(targets.codex.path!, ['--version'], { env: targets.codex.env, encoding: 'utf8' }).trim(), 'codex-cli 0.157.0');
    assert.equal((await detectCodex(targets.codex.path!, { env: targets.codex.env })).available, true);
    assert.equal((await detectClaude(targets.claude.path!, { env: targets.claude.env })).available, true);
    assert.equal(targets.codex.env.PRIVATE_CANARY, 'preserved'); assert.equal(process.env.PATH, oldPath); assert.equal(env.PATH, '/usr/bin:/bin');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('existing selected Node stays first; fallback does not prepend all manager versions; invalid override never runs fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'xterminal-node-priority-'));
  try {
    const selected = join(home, 'selected'); const installed = join(home, '.nvm/versions/node/v24.0.0/bin');
    mkdirSync(selected); mkdirSync(installed, { recursive: true });
    symlinkSync(process.execPath, join(selected, 'node')); symlinkSync(process.execPath, join(installed, 'node'));
    writeFileSync(join(installed, 'codex'), '#!/usr/bin/env node\nconsole.log("fixture");\n', { mode: 0o700 });
    const targets = await resolveEngineTargets({ home, shell: '/missing', env: { PATH: selected } });
    assert.equal(targets.codex.env.PATH, `${selected}:${installed}`);
    const rejected = await resolveEngineTargets({ home, shell: '/missing', env: { PATH: selected, XTERMINAL_CODEX_PATH: '/nonexistent' } });
    assert.equal(rejected.codex.path, null); assert.equal(rejected.codex.failure, 'invalid-override');
    assert.match(missingEngineReason('codex', rejected.codex), /配置无效/);
    assert.doesNotMatch(missingEngineReason('codex', rejected.codex), /nonexistent/);
    assert.notEqual(dirname(targets.codex.path!), selected);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('Claude wrong version remains unavailable with actual version, login status is still required', async () => {
  const home = mkdtempSync(join(tmpdir(), 'xterminal-detection-cases-')); const cli = join(home, 'claude');
  try {
    writeFileSync(cli, `#!${process.execPath}\nconsole.log('2.2.0 (Claude Code)');\n`, { mode: 0o700 });
    const version = await detectClaude(cli, { env: { PATH: '' } }); assert.equal(version.available, false); assert.match(version.reason!, /2\.2\.0.*2\.1\.304/);
    writeFileSync(cli, `#!${process.execPath}\nconsole.log(process.argv[2] === '--version' ? '2.1.304 (Claude Code)' : '{"loggedIn":false}');\n`);
    assert.equal((await detectClaude(cli, { env: { PATH: '' } })).available, false);
    rmSync(cli); assert.equal((await detectClaude(cli, { env: { PATH: '' } })).available, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
