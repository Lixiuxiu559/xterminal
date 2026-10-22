import test from 'node:test';
import assert from 'node:assert/strict';
import { LanController } from './lan-controller.ts';
import type { LanGatewayApi, LanGatewayOptions, DeviceRecord } from '../../lan/src/types.ts';
import type { LanState } from '../../protocol/src/lan.ts';

function fixture() {
  const devices: DeviceRecord[] = [{ id: 'old', name: '旧手机', tokenHash: 'a'.repeat(64), createdAtMs: 1, expiresAtMs: Date.now() + 100000, revokedAtMs: null }];
  const events: LanState[] = []; const revoked: string[] = []; let config: LanGatewayOptions;
  let address: LanGatewayApi['address'] = null; let stopped = 0;
  const gateway: LanGatewayApi = {
    get address() { return address; }, caCertificatePath: '/tmp/public-ca.crt',
    async start() { address = { bindAddress: '192.168.1.2', port: 4444, origin: 'https://192.168.1.2:4444' }; return { address, caCertificatePath: '/tmp/public-ca.crt', pairingCode: { code: '12345678', expiresAtMs: Date.now() + 120000 } }; },
    async stop() { stopped++; address = null; }, rotatePairingCode() { return { code: '87654321', expiresAtMs: Date.now() + 120000 }; },
    async approvePairing() {}, rejectPairing() {}, async revokeDevice(id) { config.onDeviceRevoked(`device:${id}`); },
    async listDevices() { return devices.map(({ tokenHash: _hash, ...device }) => device); }, broadcast() {},
  };
  const controller = new LanController({ dataPath: '/tmp/xterminal-host-unit', uiPath: '/tmp/ui',
    repository: { list: () => devices, upsert: device => { devices[devices.findIndex(item => item.id === device.id)] = device; } },
    execute: async () => ({ id: 'test', ok: true, result: null }), bootstrap: () => ({}),
    onDeviceRevoked: principal => revoked.push(principal), changed: state => events.push(state),
  }, { interfaces: () => [{ address: '192.168.1.2', name: 'en0' }], createGateway: options => { config = options; return gateway; } });
  return { controller, devices, events, revoked, config: () => config, stopped: () => stopped };
}
test('LAN默认关闭、重启撤销旧授权，配对码只在本地开启/刷新响应，拒绝未选中的IP', async () => {
  const f = fixture();
  assert.equal((await f.controller.status()).enabled, false);
  await f.controller.initialize(); assert.notEqual(f.devices[0]!.revokedAtMs, null);
  await assert.rejects(f.controller.enable('0.0.0.0'), { code: 'INVALID_INTERFACE' });
  try {
    const enabled = await f.controller.enable('192.168.1.2'); assert.equal(enabled.pairingCode, '12345678');
    assert.equal((await f.controller.status()).pairingCode, undefined);
    assert.equal((await f.controller.rotate()).pairingCode, '87654321');
    assert.ok(f.events.every(event => event.pairingCode === undefined));
    const request = { ticket: 'ticket', deviceName: '手机', requestedAtMs: Date.now(), expiresAtMs: Date.now() + 10000 };
    f.config().onPairingRequest(request);
    assert.equal((await f.controller.status()).pending.length, 1);
    await f.controller.approve('ticket'); assert.equal((await f.controller.status()).pending.length, 0);
    await f.controller.revoke('old'); assert.deepEqual(f.revoked, ['device:old']);
  } finally { await f.controller.disable(); }
  assert.equal(f.stopped(), 1); assert.equal((await f.controller.status()).enabled, false);
});
