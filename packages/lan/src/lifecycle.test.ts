import test from 'node:test';
import assert from 'node:assert/strict';
import { LanGateway } from './gateway.ts';
import type { DeviceRecord, DeviceRepository } from './types.ts';
const device = (): DeviceRecord => ({ id: 'old-phone', name: 'Phone', tokenHash: 'a'.repeat(64), createdAtMs: 1, expiresAtMs: Date.now() + 10000, revokedAtMs: null });
function gateway(repository: DeviceRepository) {
  return new LanGateway({ dataPath: '/tmp/unused', uiPath: '/tmp/unused', bindAddress: '192.168.1.2', repository,
    execute: async () => ({ id: 'none', ok: true, result: null }), bootstrap: () => ({}), onPairingRequest() {}, onDeviceRevoked() {} });
}
test('未启动网关的stop也加载并撤销磁盘授权', async () => {
  const record = device(); const writes: DeviceRecord[] = [];
  const server = gateway({ list: () => [record], upsert: record => { writes.push(record); } });
  await server.stop(); assert.equal(writes.length, 1); assert.notEqual(writes[0]!.revokedAtMs, null);
});
test('撤销落盘失败后重复stop重试；并发revoke与stop等待同一写入', async () => {
  let attempts = 0; let release: (() => void) | undefined; let written = false;
  const server = gateway({ list: () => [device()], upsert: async () => {
    attempts++; if (attempts === 1) throw new Error('disk full');
    await new Promise<void>(resolve => { release = resolve; }); written = true;
  } });
  await assert.rejects(server.stop(), /disk full/);
  const revoke = server.revokeDevice('old-phone'); const stopped = server.stop();
  let finished = false; void stopped.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); assert.equal(attempts, 2); release!();
  await Promise.all([revoke, stopped]); assert.equal(written, true); assert.equal(finished, true);
  await server.stop(); assert.equal(attempts, 2);
});
test('仓储读取暂时失败后关闭可重试，失败加载不留下部分设备状态', async () => {
  let reads = 0; let writes = 0;
  const server = gateway({ list: () => { reads++; if (reads === 1) throw new Error('read unavailable'); return [device()]; }, upsert: () => { writes++; } });
  await assert.rejects(server.stop(), /read unavailable/);
  await server.stop(); assert.equal(reads, 2); assert.equal(writes, 1);
});
