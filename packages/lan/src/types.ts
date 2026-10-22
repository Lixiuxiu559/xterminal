import type { LanMode } from '../../protocol/src/lan.ts';
import type { AppEvent, RpcResponse } from '../../protocol/src/desktop.ts';

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  createdAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
}
export type DeviceSummary = Omit<DeviceRecord, 'tokenHash'>;
export interface DeviceRepository {
  list(): DeviceRecord[] | Promise<DeviceRecord[]>;
  upsert(device: DeviceRecord): void | Promise<void>;
}
export interface PairingCode { code: string; expiresAtMs: number }
export interface PairingRequest {
  ticket: string;
  deviceName: string;
  requestedAtMs: number;
  expiresAtMs: number;
}
export interface LanAddress { bindAddress: string; port: number; origin: string; mode: LanMode }
export interface LanStarted {
  address: LanAddress;
  pairingCode: PairingCode;
  caCertificatePath: string | null;
}
export interface LanGatewayOptions {
  dataPath: string;
  uiPath: string;
  bindAddress: string;
  mode?: LanMode;
  port?: number;
  repository?: DeviceRepository;
  execute: (principalId: string, request: unknown) => Promise<RpcResponse>;
  bootstrap: (principalId: string) => unknown | Promise<unknown>;
  onPairingRequest: (request: PairingRequest) => void;
  onDeviceRevoked: (principalId: string) => void;
}
/** Public production API. Construction never opens a listener. */
export interface LanGatewayApi {
  readonly address: LanAddress | null;
  readonly caCertificatePath: string | null;
  start(): Promise<LanStarted>;
  stop(): Promise<void>;
  rotatePairingCode(): PairingCode;
  approvePairing(ticket: string): Promise<void>;
  rejectPairing(ticket: string): void;
  revokeDevice(deviceId: string): Promise<void>;
  listDevices(): Promise<DeviceSummary[]>;
  broadcast(event: AppEvent): void;
}
/** Injected only by tests; loopback is never a production option. */
export interface LanTestDependencies {
  allowLoopback?: boolean;
  now?: () => number;
}
