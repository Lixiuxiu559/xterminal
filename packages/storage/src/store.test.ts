import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { Store } from './store.ts';
import type { DeviceRecord, DeviceRepository } from '../../lan/src/types.ts';

const schema = new URL('../../../docs/architecture/schema.sql', import.meta.url).pathname;
const roots: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xterminal-store-'));
  roots.push(root);
  const dbPath = join(root, 'private', 'state.sqlite');
  const projectPath = join(root, 'project');
  mkdirSync(projectPath);
  function open() {
    const store = new Store(dbPath, schema, (path) => new DatabaseSync(path));
    stores.push(store);
    return store;
  }
  const store = open();
  function close() { stores.splice(stores.indexOf(store), 1); store.close(); }
  return { root, dbPath, projectPath, store, open, close };
}

test('D01: canonical paths are idempotent; missing paths and files are rejected', () => {
  const { root, store, projectPath, dbPath } = fixture();
  const link = join(root, 'link');
  symlinkSync(projectPath, link);
  const project = store.addProject(projectPath);
  assert.deepEqual(store.addProject(link), project);
  assert.equal(store.listProjects().length, 1);
  assert.throws(() => store.addProject(join(root, 'missing')));
  assert.throws(() => store.addProject(dbPath), { code: 'INVALID_PROJECT_PATH' });
  assert.equal(statSync(join(root, 'private')).mode & 0o777, 0o700);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('D02: rename persists and rejects stale revision; project and engine remain immutable', () => {
  const f = fixture();
  const project = f.store.addProject(f.projectPath);
  const session = f.store.createSession({ id: 'create-1', projectId: project.id, engine: 'shell', title: ' Shell ' });
  const renamed = f.store.renameSession(session.id, 'New title', 1);
  assert.equal(renamed.revision, 2);
  assert.throws(() => f.store.renameSession(session.id, 'Old update', 1), { code: 'REVISION_CONFLICT' });
  f.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getSession(session.id), renamed);
  assert.equal(renamed.engine, 'shell');
  assert.equal(renamed.initialCwd, project.rootPath);
  const db = new DatabaseSync(f.dbPath);
  try {
    assert.throws(() => db.prepare("UPDATE sessions SET engine = 'codex' WHERE id = ?").run(session.id), /SESSION_ENGINE_IMMUTABLE/);
    assert.throws(() => db.prepare("UPDATE sessions SET initial_cwd = '/other' WHERE id = ?").run(session.id), /SESSION_PROJECT_IMMUTABLE/);
  } finally { db.close(); }
});

test('creation replays the original payload even after rename; conflicts and invalid data leave no session', () => {
  const { store, projectPath } = fixture();
  const project = store.addProject(projectPath);
  const input = { id: 'create-1', projectId: project.id, engine: 'shell' as const, title: 'Original' };
  const original = store.createSession(input);
  assert.deepEqual(store.createSession(input), original);
  const renamed = store.renameSession(input.id, 'Renamed', 1);
  assert.deepEqual(store.createSession(input), renamed);
  assert.throws(() => store.createSession({ ...input, engine: 'codex' }), { code: 'COMMAND_ID_REUSED' });
  assert.throws(() => store.createSession({ ...input, title: 'Different' }), { code: 'COMMAND_ID_REUSED' });
  assert.throws(() => store.createSession({ ...input, id: 'missing', projectId: 'missing' }), { code: 'PROJECT_NOT_FOUND' });
  assert.throws(() => store.createSession({ ...input, id: 'invalid', engine: 'bad' as 'shell' }), { code: 'INVALID_ENGINE' });
  for (const title of ['', ' ', 'x'.repeat(61)]) assert.throws(() => store.createSession({ ...input, id: 'invalid', title }), { code: 'INVALID_TITLE' });
  assert.equal(store.listSessions().length, 1);
});

test('D09: restart recovers active runs without starting replacements; only one active run per session', () => {
  const f = fixture();
  const project = f.store.addProject(f.projectPath);
  const session = f.store.createSession({ id: 'session', projectId: project.id, engine: 'shell', title: 'Shell' });
  assert.equal(f.store.lastRun(session.id), null);
  f.store.beginRun({ id: 'run-1', sessionId: session.id, hostInstanceId: 'host-1' });
  assert.throws(() => f.store.beginRun({ id: 'run-2', sessionId: session.id, hostInstanceId: 'host-1' }), /UNIQUE/);
  f.close();
  const reopened = f.open();
  reopened.recoverRuns();
  assert.equal(reopened.listProjects().length, 1);
  assert.equal(reopened.listSessions().length, 1);
  assert.deepEqual(reopened.lastRun(session.id), { id: 'run-1', status: 'interrupted' });
  reopened.beginRun({ id: 'run-2', sessionId: session.id, hostInstanceId: 'host-2' });
  reopened.finishRun('run-2', 'failed', 'SPAWN_FAILED');
  reopened.recoverRuns();
  assert.deepEqual(reopened.lastRun(session.id), { id: 'run-2', status: 'failed' });
  const db = new DatabaseSync(f.dbPath);
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n, 2);
    assert.equal((db.prepare('SELECT count(*) AS n FROM session_events').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT error_code FROM runs WHERE id = ?').get('run-2') as { error_code: string }).error_code, 'SPAWN_FAILED');
  } finally { db.close(); }
});

test('unsupported migration versions are rejected without overwriting existing data', () => {
  const f = fixture();
  f.store.addProject(f.projectPath);
  f.close();
  const db = new DatabaseSync(f.dbPath);
  db.prepare('UPDATE schema_migrations SET version = 99').run();
  db.close();
  assert.throws(() => f.open(), { code: 'UNSUPPORTED_SCHEMA_VERSION' });
  const check = new DatabaseSync(f.dbPath);
  try {
    assert.equal((check.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 1);
    assert.equal((check.prepare('SELECT version FROM schema_migrations').get() as { version: number }).version, 99);
  } finally { check.close(); }
});


test('SQLite DeviceRepository updates revocation and persists exact millisecond values after reopening', () => {
  const f = fixture();
  const repository: DeviceRepository = { list: () => f.store.listDevices(), upsert: device => f.store.upsertDevice(device) };
  const device: DeviceRecord = { id: 'device-1', name: '手机', tokenHash: 'a'.repeat(64), createdAtMs: 1761000000123, expiresAtMs: 1762000000456, revokedAtMs: null };
  assert.deepEqual(repository.list(), []);
  repository.upsert(device);
  assert.deepEqual(repository.list(), [device]);
  const revoked = { ...device, name: '手机（已撤销）', revokedAtMs: 1761000000789 };
  repository.upsert(revoked);
  assert.deepEqual(repository.list(), [revoked]);
  f.close();
  const reopened = f.open();
  assert.deepEqual(reopened.listDevices(), [revoked]);
  const copy = reopened.listDevices(); copy[0].name = 'changed only in caller';
  assert.deepEqual(reopened.listDevices(), [revoked]);
  const db = new DatabaseSync(f.dbPath);
  try {
    const row = db.prepare('SELECT token_hash, created_at, expires_at, revoked_at FROM devices').get() as Record<string, string>;
    assert.equal(row.token_hash, device.tokenHash);
    assert.equal(row.created_at, new Date(device.createdAtMs).toISOString());
    assert.equal(row.revoked_at, new Date(revoked.revokedAtMs).toISOString());
    assert.equal((db.prepare('SELECT count(*) AS n FROM session_events').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('device values are bound, only token hashes are accepted and conflicting updates roll back', () => {
  const { store, dbPath } = fixture();
  const first: DeviceRecord = { id: "device'); DROP TABLE devices; --", name: "手机'); DROP TABLE projects; --", tokenHash: 'a'.repeat(64), createdAtMs: 1761000000123, expiresAtMs: 1762000000456, revokedAtMs: null };
  const second = { ...first, id: 'device-2', tokenHash: 'b'.repeat(64) };
  store.upsertDevice(first); store.upsertDevice(second);
  assert.equal(store.listDevices().length, 2);
  assert.throws(() => store.upsertDevice({ ...first, name: 'should not persist', tokenHash: second.tokenHash }), /UNIQUE/);
  assert.deepEqual(store.listDevices().find(device => device.id === first.id), first);
  assert.throws(() => store.upsertDevice({ ...first, tokenHash: 'plaintext-device-secret' }), { code: 'INVALID_DEVICE' });
  assert.throws(() => store.upsertDevice({ ...first, expiresAtMs: NaN }), { code: 'INVALID_DEVICE' });
  assert.throws(() => store.upsertDevice({ ...first, revokedAtMs: 1.5 }), { code: 'INVALID_DEVICE' });
  assert.equal(store.listDevices().length, 2);
  const db = new DatabaseSync(dbPath);
  try { assert.equal((db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n, 0); }
  finally { db.close(); }
});
