import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FileDeviceRepository } from './repository.ts';
import { LanGateway } from './gateway.ts';

test('hash-only仓储并发原子写入，重载后默认关闭也可列举和撤销设备', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'xterminal-devices-'));
  try {
    const repository = new FileDeviceRepository(directory);
    const token = 'test-token-must-not-be-persisted';
    const devices = Array.from({ length: 20 }, (_, i) => ({ id: randomUUID(), name: `device-${i}`,
      tokenHash: createHash('sha256').update(token + i).digest('hex'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 86400000, revokedAtMs: null }));
    await Promise.all(devices.map((device) => repository.upsert(device)));
    const raw = await readFile(join(directory, 'devices.json'), 'utf8');
    assert.equal(raw.includes(token), false); assert.equal(JSON.parse(raw).length, 20);
    assert.equal((await stat(join(directory, 'devices.json'))).mode & 0o777, 0o600);
    const reloaded = new FileDeviceRepository(directory);
    assert.equal((await reloaded.list()).length, 20);
    const revoked: string[] = [];
    const gateway = new LanGateway({ dataPath: directory, uiPath: directory, bindAddress: '192.168.1.2', repository: reloaded,
      bootstrap: () => ({}), execute: async () => ({ id: 'x', ok: true, result: {} }), onPairingRequest: () => {}, onDeviceRevoked: (id) => revoked.push(id) });
    assert.equal(gateway.address, null);
    const summaries = await gateway.listDevices(); assert.equal(summaries.length, 20); assert.equal('tokenHash' in summaries[0]!, false);
    await gateway.revokeDevice(devices[0]!.id);
    assert.deepEqual(revoked, [`device:${devices[0]!.id}`]);
    assert.notEqual((await reloaded.list()).find((device) => device.id === devices[0]!.id)!.revokedAtMs, null);
    assert.equal(gateway.address, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
