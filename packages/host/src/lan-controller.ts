import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LanGateway, isPrivateIPv4 } from '../../lan/src/index.ts';
import type { DeviceRepository, LanGatewayApi, LanGatewayOptions, PairingRequest } from '../../lan/src/types.ts';
import type { AppEvent } from '../../protocol/src/desktop.ts';
import type { LanInterface, LanState } from '../../protocol/src/lan.ts';
import { HostError } from './validation.ts';

export function lanInterfaces(): LanInterface[] {
  const result: LanInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) if (!address.internal && address.family === 'IPv4' && isPrivateIPv4(address.address)) {
      if (!result.some(item => item.address === address.address)) result.push({ address: address.address, name });
    }
  }
  return result;
}
interface Options extends Omit<LanGatewayOptions, 'bindAddress' | 'onPairingRequest'> {
  changed: (state: LanState) => void;
  repository: DeviceRepository;
}
export interface LanControllerServices {
  interfaces: () => LanInterface[];
  createGateway: (options: LanGatewayOptions) => LanGatewayApi;
}
/** Local management only. The Host checks desktop identity before invoking these methods. */
export class LanController {
  private gateway: LanGatewayApi | null = null;
  private readonly pending = new Map<string, PairingRequest>();
  private readonly services: LanControllerServices;
  private timer: NodeJS.Timeout | undefined;
  private certificatePath: string;
  private readonly options: Options;
  constructor(options: Options, services: Partial<LanControllerServices> = {}) {
    this.options = options;
    this.services = { interfaces: lanInterfaces, createGateway: options => new LanGateway(options), ...services };
    this.certificatePath = join(options.dataPath, 'certificates', 'ca.crt');
  }
  publicCertificatePath(): string | null { return existsSync(this.certificatePath) ? this.certificatePath : null; }
  async initialize(): Promise<void> {
    // Restart starts with LAN disabled; a previous crash must not revive browser grants.
    for (const device of await this.options.repository.list()) if (device.revokedAtMs === null) {
      await this.options.repository.upsert({ ...device, revokedAtMs: Date.now() });
    }
  }
  async status(): Promise<LanState> {
    const now = Date.now();
    for (const [ticket, request] of this.pending) if (request.expiresAtMs <= now) this.pending.delete(ticket);
    const devices = this.gateway ? await this.gateway.listDevices() : (await this.options.repository.list()).map(({ tokenHash: _hash, ...device }) => device);
    return { enabled: Boolean(this.gateway?.address), origin: this.gateway?.address?.origin ?? null,
      interfaces: this.services.interfaces(), devices, pending: [...this.pending.values()], certificateReady: this.publicCertificatePath() !== null };
  }
  private async changed(): Promise<LanState> { const state = await this.status(); this.options.changed(state); return state; }
  async enable(address: string): Promise<LanState> {
    if (!this.services.interfaces().some(item => item.address === address)) throw new HostError('INVALID_INTERFACE', '所选内网地址已失效，请刷新后重选');
    if (this.gateway?.address?.bindAddress === address) return this.status();
    await this.disable();
    const gateway = this.services.createGateway({ ...this.options, bindAddress: address,
      onPairingRequest: request => { this.pending.set(request.ticket, request); void this.changed().catch(() => {}); },
    });
    this.gateway = gateway;
    try {
      const started = await gateway.start();
      this.certificatePath = started.caCertificatePath;
      this.timer = setInterval(() => {
        if (this.gateway !== gateway) return;
        if (!gateway.address || !this.services.interfaces().some(item => item.address === address)) {
          void this.disable().catch(() => {});
        }
      }, 5000);
      this.timer.unref();
      const state = await this.changed();
      return { ...state, pairingCode: started.pairingCode.code, pairingExpiresAtMs: started.pairingCode.expiresAtMs };
    } catch (error) {
      await gateway.stop().catch(() => {}); this.gateway = null; await this.changed(); throw error;
    }
  }
  async disable(): Promise<LanState> {
    clearInterval(this.timer); this.timer = undefined; this.pending.clear();
    const gateway = this.gateway;
    // Retain a failed gateway so a later disable/exit can retry durable revocation.
    if (gateway) { await gateway.stop(); if (this.gateway === gateway) this.gateway = null; }
    return this.changed();
  }
  async rotate(): Promise<LanState> {
    if (!this.gateway?.address) throw new HostError('LAN_DISABLED', '请先开启局域网访问');
    const code = this.gateway.rotatePairingCode();
    return { ...await this.changed(), pairingCode: code.code, pairingExpiresAtMs: code.expiresAtMs };
  }
  async approve(ticket: string): Promise<LanState> {
    if (!this.gateway) throw new HostError('LAN_DISABLED', '局域网访问已关闭');
    await this.gateway.approvePairing(ticket); this.pending.delete(ticket); return this.changed();
  }
  async reject(ticket: string): Promise<LanState> {
    this.gateway?.rejectPairing(ticket); this.pending.delete(ticket); return this.changed();
  }
  async revoke(deviceId: string): Promise<LanState> {
    if (this.gateway) await this.gateway.revokeDevice(deviceId);
    else {
      const device = (await this.options.repository.list()).find(item => item.id === deviceId);
      if (device && device.revokedAtMs === null) await this.options.repository.upsert({ ...device, revokedAtMs: Date.now() });
      this.options.onDeviceRevoked(`device:${deviceId}`);
    }
    return this.changed();
  }
  broadcast(event: AppEvent): void { this.gateway?.broadcast(event); }
}
