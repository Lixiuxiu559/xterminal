/** 产品契约 v1。运行时校验在传输边界完成，不把 TS 类型当作输入验证。 */
export const PROTOCOL_VERSION = 1 as const;
export type EngineKind = 'claude' | 'codex' | 'shell';
export type AgentEngineKind = Exclude<EngineKind, 'shell'>;
export type AgentState =
  | 'idle' | 'starting' | 'running' | 'waiting' | 'stopping'
  | 'interrupted' | 'error';
export type ShellState = 'starting' | 'running' | 'exited' | 'error';
export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface SessionIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly engine: EngineKind;
  readonly initialCwd: string;
}
export type Session = SessionIdentity & {
  title: string;
  revision: number;
  lastSeq: number;
} & (
  | { engine: AgentEngineKind; state: AgentState; nativeContextId: string | null }
  | { engine: 'shell'; state: ShellState; terminalEpoch: string | null }
);

export interface ControlStamp {
  readonly hostInstanceId: string;
  readonly generation: number;
}
export interface ControlLease extends ControlStamp {
  readonly principalId: string;
  readonly expiresAtMs: number;
}
export interface CommandEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  sessionId: string;
  expectedRevision: number;
}
interface ControlledCommand extends CommandEnvelope {
  control: ControlStamp;
}
export type InteractionResponse =
  | { kind: 'permission'; action: 'allow-once' | 'deny' | 'cancel-turn' }
  | { kind: 'question'; answers: Record<string, string[]> }
  | { kind: 'engine-specific'; engine: AgentEngineKind; action: string; input: Record<string, unknown> };

export type ReliableCommand =
  | (CommandEnvelope & {
      type: 'session.create';
      payload: { projectId: string; engine: EngineKind; title: string };
    })
  | (CommandEnvelope & { type: 'session.rename'; payload: { title: string } })
  | (CommandEnvelope & { type: 'control.acquire'; payload: Record<string, never> })
  | (ControlledCommand & { type: 'control.release'; payload: Record<string, never> })
  | (ControlledCommand & { type: 'agent.turn.start'; payload: { text: string } })
  | (ControlledCommand & { type: 'agent.turn.stop'; payload: { runId: string } })
  | (ControlledCommand & { type: 'interaction.respond'; payload: { interactionId: string; runId: string; response: InteractionResponse } })
  | (ControlledCommand & { type: 'shell.start'; payload: Record<string, never> })
  | (ControlledCommand & { type: 'shell.terminate'; payload: { runId: string } });

export interface TerminalInput {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: 'terminal.input';
  sessionId: string;
  runId: string;
  terminalEpoch: string;
  inputId: string;
  control: ControlStamp;
  data: string;
}
export interface TerminalOutput {
  protocolVersion: typeof PROTOCOL_VERSION;
  type: 'terminal.output';
  sessionId: string;
  runId: string;
  terminalEpoch: string;
  outputSeq: number;
  data: string;
}
export interface TerminalSnapshot {
  sessionId: string;
  runId: string;
  terminalEpoch: string;
  cols: number;
  rows: number;
  parsedOutputSeq: number;
  serializedState: string;
}
export interface EngineCapabilities {
  engine: EngineKind;
  adapterVersion: string;
  providerVersion: string;
  available: boolean;
  unavailableReason?: string;
  interactions: Array<'permission' | 'question' | 'plan' | 'elicitation'>;
  canInterrupt: boolean;
  canResumeContext: boolean;
  extensions: string[];
}
export interface DomainEvent<T extends string = string, P = unknown> {
  protocolVersion: typeof PROTOCOL_VERSION;
  eventId: string;
  sessionId: string;
  seq: number;
  revision: number;
  occurredAt: string;
  type: T;
  runId?: string;
  payload: P;
}
export interface CommandReceipt {
  commandId: string;
  status: 'accepted' | 'duplicate' | 'rejected';
  error?: { code: string; message: string; retryable: boolean; currentRevision?: number };
}
