export type LanMode = 'http' | 'https';
export interface LanInterface { address: string; name: string }
export interface LanDevice { id: string; name: string; createdAtMs: number; expiresAtMs: number; revokedAtMs: number | null }
export interface LanPending { ticket: string; deviceName: string; requestedAtMs: number; expiresAtMs: number }
export interface LanState {
  mode: LanMode | null;
  enabled: boolean; origin: string | null; interfaces: LanInterface[];
  devices: LanDevice[]; pending: LanPending[]; certificateReady: boolean;
  // Revealed only in the local enable/rotate response, never broadcast to phones.
  pairingCode?: string; pairingExpiresAtMs?: number;
}
