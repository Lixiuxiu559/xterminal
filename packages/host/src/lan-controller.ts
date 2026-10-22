import { networkInterfaces } from 'node:os';
import { LanGateway, isPrivateIPv4 } from '../../lan/src/index.ts';
import type { DeviceRepository, LanGatewayApi, LanGatewayOptions, PairingRequest } from '../../lan/src/types.ts';
import type { AppEvent } from '../../protocol/src/desktop.ts';
import type { LanInterface, LanState, LanMode } from '../../protocol/src/lan.ts';
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
interface Options extends Omit<LanGatewayOptions, 'bindAddress' | 'onPairingRequest' | 'mode'> {
  changed: (state: LanState) => void;
  repository: DeviceRepository;
}
export interface LanControllerServices {
  interfaces: () => LanInterface[];
  createGateway: (options: LanGatewayOptions) => LanGatewayApi;
}
/** Only desktop management can change the mode. Management is serialized across timers and RPCs. */
export class LanController {
  private gateway: LanGatewayApi | null = null;
  private readonly pending = new Map<string, PairingRequest>();
  private readonly services: LanControllerServices;
  private timer: NodeJS.Timeout | undefined;
  private readonly options: Options;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(options: Options, services: Partial<LanControllerServices> = {}) {
    this.options = options;
    this.services = { interfaces: lanInterfaces, createGateway: options => new LanGateway(options), ...services };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }
  publicCertificatePath(): string | null {
    return this.gateway?.address?.mode === 'https' ? this.gateway.caCertificatePath : null;
  }
  async initialize(): Promise<void> {
    for (const device of await this.options.repository.list()) if (device.revokedAtMs === null) {
      await this.options.repository.upsert({ ...device, revokedAtMs: Date.now() });
    }
  }
  async status(): Promise<LanState> {
    const now = Date.now();
    for (const [ticket, request] of this.pending) if (request.expiresAtMs <= now) this.pending.delete(ticket);
    const devices = this.gateway ? await this.gateway.listDevices() : (await this.options.repository.list()).map(({ tokenHash: _hash, ...device }) => device);
    const address = this.gateway?.address;
    return { enabled: Boolean(address), mode: address?.mode ?? null, origin: address?.origin ?? null,
      interfaces: this.services.interfaces(), devices, pending: [...this.pending.values()], certificateReady: this.publicCertificatePath() !== null };
  }
  private async changed(): Promise<LanState> { const state = await this.status(); this.options.changed(state); return state; }
  enable(address: string, mode: LanMode = 'https'): Promise<LanState> { return this.serial(() => this.start(address, mode)); }
  private async start(address: string, mode: LanMode): Promise<LanState> {
    if (mode !== 'http' && mode !== 'https') throw new HostError('INVALID_REQUEST', '连接模式无效');
    if (!this.services.interfaces().some(item => item.address === address)) throw new HostError('INVALID_INTERFACE', '所选内网地址已失效，请刷新后重选');
    if (this.gateway?.address) {
      if (this.gateway.address.bindAddress === address && this.gateway.address.mode === mode) return this.status();
      throw new HostError('LAN_ALREADY_ENABLED', '请先关闭连接，再切换地址或连接模式并重新配对。');
    }
    if (this.gateway) throw new HostError('LAN_CLEANUP_PENDING', '旧授权清理尚未完成，请重试关闭连接。');
    const gateway = this.services.createGateway({ ...this.options, bindAddress: address, mode,
      onPairingRequest: request => { if (this.gateway === gateway) { this.pending.set(request.ticket, request); void this.changed().catch(() => {}); } },
    });
    this.gateway = gateway;
    try {
      const started = await gateway.start();
      this.timer = setInterval(() => {
        void this.serial(async () => {
          if (this.gateway === gateway && (!gateway.address || !this.services.interfaces().some(item => item.address === address))) await this.stop();
        }).catch(() => {});
      }, 5000);
      this.timer.unref();
      return { ...await this.changed(), pairingCode: started.pairingCode.code, pairingExpiresAtMs: started.pairingCode.expiresAtMs };
    } catch (error) {
      // A failed durable cleanup must retain its gateway so disable/exit can retry.
      try { await gateway.stop(); if (this.gateway === gateway) this.gateway = null; }
      catch (cleanupError) { throw cleanupError; }
      await this.changed(); throw error;
    }
  }
  disable(): Promise<LanState> { return this.serial(() => this.stop()); }
  private async stop(): Promise<LanState> {
    clearInterval(this.timer); this.timer = undefined; this.pending.clear();
    const gateway = this.gateway;
    if (gateway) { await gateway.stop(); if (this.gateway === gateway) this.gateway = null; }
    return this.changed();
  }
  rotate(): Promise<LanState> { return this.serial(async () => {
    if (!this.gateway?.address) throw new HostError('LAN_DISABLED', '请先开启局域网访问');
    const code = this.gateway.rotatePairingCode();
    return { ...await this.changed(), pairingCode: code.code, pairingExpiresAtMs: code.expiresAtMs };
  }); }
  approve(ticket: string): Promise<LanState> { return this.serial(async () => {
    if (!this.gateway?.address) throw new HostError('LAN_DISABLED', '局域网访问已关闭');
    await this.gateway.approvePairing(ticket); this.pending.delete(ticket); return this.changed();
  }); }
  reject(ticket: string): Promise<LanState> { return this.serial(async () => {
    this.gateway?.rejectPairing(ticket); this.pending.delete(ticket); return this.changed();
  }); }
  revoke(deviceId: string): Promise<LanState> { return this.serial(async () => {
    if (this.gateway) await this.gateway.revokeDevice(deviceId);
    else {
      const device = (await this.options.repository.list()).find(item => item.id === deviceId);
      if (device && device.revokedAtMs === null) await this.options.repository.upsert({ ...device, revokedAtMs: Date.now() });
      this.options.onDeviceRevoked(`device:${deviceId}`);
    }
    return this.changed();
  }); }
  broadcast(event: AppEvent): void { this.gateway?.broadcast(event); }
}
