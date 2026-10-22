import type { EngineKind, TerminalOutput, TerminalSnapshot, ControlLease, ControlStamp } from './index.ts';
import type { AgentAnswer, AgentSnapshot, AgentModel } from './agent.ts';
import type { LanState, LanMode } from './lan.ts';

export interface ProjectRecord {
  id: string; name: string; rootPath: string; createdAt: string; updatedAt: string;
}
export interface SessionRecord {
  id: string; projectId: string; engine: EngineKind; title: string; initialCwd: string;
  revision: number; lastSeq: number; createdAt: string; updatedAt: string;
}
export interface AppSession extends SessionRecord {
  state: 'idle' | 'starting' | 'running' | 'waiting' | 'stopping' | 'interrupted' | 'exited' | 'error';
  runId: string | null; error: string | null;
  control?: ControlLease | null;
}
export interface EngineAvailability {
  engine: EngineKind; available: boolean; version: string | null; reason: string | null;
}
export interface Bootstrap {
  hostInstanceId: string; projects: ProjectRecord[]; sessions: AppSession[];
  engines: EngineAvailability[];
  principalId?: string;
}
export interface RequestMap {
  bootstrap: { params: Record<string, never>; result: Bootstrap };
  'control.acquire': { params: { sessionId: string }; result: ControlLease };
  'control.renew': { params: { sessionId: string }; result: ControlLease };
  'control.release': { params: { sessionId: string }; result: null };
  'lan.status': { params: Record<string, never>; result: LanState };
  'lan.enable': { params: { address: string; mode?: LanMode }; result: LanState };
  'lan.disable': { params: Record<string, never>; result: LanState };
  'lan.rotateCode': { params: Record<string, never>; result: LanState };
  'lan.approve': { params: { ticket: string }; result: LanState };
  'lan.reject': { params: { ticket: string }; result: LanState };
  'lan.revoke': { params: { deviceId: string }; result: LanState };
  'lan.exportCertificate': { params: Record<string, never>; result: { saved: boolean } };
  'session.create': { params: { projectId: string; engine: EngineKind; title: string; commandId: string }; result: AppSession };
  'session.rename': { params: { sessionId: string; title: string; expectedRevision: number }; result: AppSession };
  'shell.start': { params: { sessionId: string; cols: number; rows: number }; result: AppSession };
  'shell.input': { params: { sessionId: string; runId: string; terminalEpoch: string; inputId: string; data: string }; result: { written: true } };
  'shell.resize': { params: { sessionId: string; runId: string; terminalEpoch: string; cols: number; rows: number }; result: TerminalSnapshot };
  'shell.snapshot': { params: { sessionId: string }; result: TerminalSnapshot | null };
  'shell.terminate': { params: { sessionId: string; runId: string }; result: AppSession };
  'agent.snapshot': { params: { sessionId: string }; result: AgentSnapshot };
  'agent.turn.start': { params: { sessionId: string; text: string; commandId: string; model?: string }; result: AppSession };
  'engine.models': { params: { engine: 'codex' }; result: AgentModel[] };
  'agent.turn.stop': { params: { sessionId: string; runId: string }; result: AppSession };
  'agent.respond': { params: { sessionId: string; runId: string; interactionId: string; answer: AgentAnswer }; result: AgentSnapshot };
}
export type AppMethod = keyof RequestMap;
export type AppEvent =
  | { type: 'catalog.changed'; snapshot: Bootstrap }
  | { type: 'agent.changed'; snapshot: AgentSnapshot }
  | { type: 'lan.changed'; state: LanState }
  | TerminalOutput
  | { type: 'host.offline'; message: string };
export interface AppError { code: string; message: string }
export interface RpcRequest { id: string; method: string; params: unknown; control?: ControlStamp }
export type RpcResponse = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: AppError };
export interface DesktopBridge {
  readonly principalId?: string;
  readonly kind?: 'desktop' | 'browser';
  invoke<K extends AppMethod>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']>;
  selectProject(): Promise<ProjectRecord | null>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}
