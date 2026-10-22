import type {
  AgentState, ControlLease, ControlStamp, EngineKind, SessionIdentity,
} from '../../protocol/src/index.ts';

export class PolicyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function assertFixedEngine(session: SessionIdentity, requested: EngineKind): void {
  if (session.engine !== requested) {
    throw new PolicyError('SESSION_ENGINE_IMMUTABLE', '会话创建后不能切换引擎');
  }
}

export type AgentSignal =
  | 'start_requested' | 'engine_started' | 'input_requested' | 'input_resolved'
  | 'stop_requested' | 'stop_confirmed' | 'turn_completed' | 'process_lost'
  | 'restore_requested' | 'context_restored' | 'failure';

const transitions: Record<AgentState, Partial<Record<AgentSignal, AgentState>>> = {
  idle: { start_requested: 'starting', process_lost: 'idle', failure: 'error' },
  starting: {
    engine_started: 'running', context_restored: 'idle', stop_requested: 'stopping',
    process_lost: 'interrupted', failure: 'error',
  },
  running: {
    input_requested: 'waiting', stop_requested: 'stopping', turn_completed: 'idle',
    process_lost: 'interrupted', failure: 'error',
  },
  waiting: {
    input_resolved: 'running', stop_requested: 'stopping', turn_completed: 'idle',
    process_lost: 'interrupted', failure: 'error',
  },
  stopping: {
    stop_requested: 'stopping', stop_confirmed: 'idle', turn_completed: 'idle',
    process_lost: 'interrupted', failure: 'error',
  },
  interrupted: { restore_requested: 'starting', process_lost: 'interrupted', failure: 'error' },
  error: { restore_requested: 'starting', process_lost: 'error', failure: 'error' },
};

/** signal 必须已绑定当前 run；旧 run 事件在 actor 层拒绝。 */
export function transitionAgent(state: AgentState, signal: AgentSignal): AgentState {
  const next = transitions[state][signal];
  if (!next) throw new PolicyError('INVALID_TRANSITION', `${state} 不能处理 ${signal}`);
  return next;
}

/** 此函数只管理租约，不替代设备认证与项目授权。 */
export function grantControl(
  previous: ControlLease | null,
  hostInstanceId: string,
  principalId: string,
  nowMs: number,
  ttlMs = 15_000,
): ControlLease {
  if (!hostInstanceId.trim() || !principalId.trim() || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(nowMs + ttlMs)) {
    throw new PolicyError('INVALID_LEASE', '控制权参数无效');
  }
  const generation = previous?.hostInstanceId === hostInstanceId ? previous.generation + 1 : 1;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new PolicyError('INVALID_LEASE', '控制权版本无效');
  }
  return { hostInstanceId, principalId, generation, expiresAtMs: nowMs + ttlMs };
}

export function assertControl(
  lease: ControlLease | null,
  principalId: string,
  stamp: ControlStamp,
  nowMs: number,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new PolicyError('INVALID_LEASE', '校验时间无效');
  }
  if (!lease || nowMs >= lease.expiresAtMs) {
    throw new PolicyError('CONTROL_REQUIRED', '请先取得会话控制权');
  }
  if (lease.principalId !== principalId || lease.hostInstanceId !== stamp.hostInstanceId || lease.generation !== stamp.generation) {
    throw new PolicyError('STALE_CONTROL', '会话控制权已变化，请重新接管');
  }
}
