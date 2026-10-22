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
    async start() { address = { bindAddress: '192.168.1.2', mode: config.mode ?? 'https', port: 4444, origin: `${config.mode ?? 'https'}://192.168.1.2:4444` }; return { address, caCertificatePath: '/tmp/public-ca.crt', pairingCode: { code: '12345678', expiresAtMs: Date.now() + 120000 } }; },
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

test('mode changes require completed disable; HTTP has no certificate export and omitted mode stays HTTPS', async () => {
 const f = fixture();
 try {
  assert.equal((await f.controller.status()).mode, null);
  const http = await f.controller.enable('192.168.1.2', 'http');
  assert.equal(http.mode, 'http'); assert.equal(http.certificateReady, false); assert.equal(f.controller.publicCertificatePath(), null);
  await assert.rejects(f.controller.enable('192.168.1.2', 'https'), { code: 'LAN_ALREADY_ENABLED' });
  assert.equal(f.stopped(), 0);
  await f.controller.disable();
  assert.equal((await f.controller.status()).mode, null);
  assert.equal((await f.controller.enable('192.168.1.2')).mode, 'https');
  assert.equal(f.controller.publicCertificatePath(), '/tmp/public-ca.crt');
 } finally { await f.controller.disable(); }
});

test('failed durable revocation retains gateway and blocks a new mode until disable retry succeeds', async () => {
 let fail = true; let created = 0; let address: LanGatewayApi['address'] = null;
 const controller = new LanController({ dataPath:'/tmp/test', uiPath:'/tmp/ui', repository:{list:()=>[],upsert:()=>{}}, execute:async()=>({id:'i',ok:true,result:null}),bootstrap:()=>({}),onDeviceRevoked:()=>{},changed:()=>{} }, {interfaces:()=>[{address:'192.168.1.2',name:'test'}],createGateway:options=>{created++;return {get address(){return address;},caCertificatePath:null, async start(){address={bindAddress:options.bindAddress,port:4444,origin:(options.mode ?? 'https')+'://192.168.1.2:4444',mode:options.mode ?? 'https'};return {address,caCertificatePath:null,pairingCode:{code:'12345678',expiresAtMs:Date.now()+120000}};},async stop(){address=null;if(fail)throw Error('persist-failed');},rotatePairingCode(){throw Error('unused');},async approvePairing(){},rejectPairing(){},async revokeDevice(){},async listDevices(){return [];},broadcast(){}};}});
 await controller.enable('192.168.1.2','http');
 await assert.rejects(controller.disable(),/persist-failed/);
 await assert.rejects(controller.enable('192.168.1.2','https'),{code:'LAN_CLEANUP_PENDING'});assert.equal(created,1);
 fail=false;await controller.disable();await controller.enable('192.168.1.2','https');assert.equal(created,2);await controller.disable();
});
