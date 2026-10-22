import { grantControl, assertControl, PolicyError } from './session-policy.ts';
import type { ControlLease, ControlStamp } from '../../protocol/src/index.ts';
export class ControlManager {
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly changed: () => void;
  private readonly active = new Map<string, ControlLease>();
  private readonly previous = new Map<string, ControlLease>();
  constructor(instanceId: string, changed: () => void, now = () => Math.floor(performance.timeOrigin + performance.now())) {
    this.instanceId = instanceId; this.changed = changed; this.now = now;
  }
  get(sessionId: string): ControlLease | null {
    const lease = this.active.get(sessionId);
    return lease && lease.expiresAtMs > this.now() ? { ...lease } : null;
  }
  acquire(sessionId: string, principalId: string): ControlLease {
    const lease = grantControl(this.previous.get(sessionId) ?? null, this.instanceId, principalId, this.now());
    this.previous.set(sessionId, lease); this.active.set(sessionId, lease); this.changed();
    return { ...lease };
  }
  assert(sessionId: string, principalId: string, stamp?: ControlStamp): void {
    if (!stamp) throw new PolicyError('CONTROL_REQUIRED', '当前为只读查看，请先接管操作');
    assertControl(this.active.get(sessionId) ?? null, principalId, stamp, this.now());
  }
  renew(sessionId: string, principalId: string, stamp?: ControlStamp): ControlLease {
    this.assert(sessionId, principalId, stamp);
    const lease = { ...this.active.get(sessionId)!, expiresAtMs: this.now() + 15000 };
    this.active.set(sessionId, lease); this.previous.set(sessionId, lease); return { ...lease };
  }
  release(sessionId: string, principalId: string, stamp?: ControlStamp): void {
    this.assert(sessionId, principalId, stamp); this.active.delete(sessionId); this.changed();
  }
  revoke(principalId: string): void {
    let changed = false;
    for (const [id, lease] of this.active) if (lease.principalId === principalId) { this.active.delete(id); changed = true; }
    if (changed) this.changed();
  }
  expire(): void {
    let changed = false;
    for (const [id, lease] of this.active) if (lease.expiresAtMs <= this.now()) { this.active.delete(id); changed = true; }
    if (changed) this.changed();
  }
}
