import type { AgentEngineKind } from './index.ts';
import type { EngineAvailability } from './desktop.ts';

export interface AgentMessage {
  id: string; runId: string; role: 'user' | 'assistant' | 'system';
  text: string; status: 'streaming' | 'completed' | 'interrupted'; createdAt: string;
}
export interface AgentQuestion {
  id: string; header: string; question: string; options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
}
export interface AgentInteraction {
  id: string; runId: string; kind: 'permission' | 'question' | 'unsupported';
  title: string; detail: string; questions?: AgentQuestion[];
  actions: Array<'allow-once' | 'deny' | 'cancel-turn' | 'submit'>;
}
export interface AgentAnswer {
  action: 'allow-once' | 'deny' | 'cancel-turn' | 'submit'; answers?: Record<string, string[]>;
}
export interface AgentTool {
  id: string; runId: string; title: string; detail: string;
  state: 'running' | 'completed' | 'failed';
}
export type AgentEngineEvent =
  | { type: 'context'; runId: string; nativeContextId: string }
  | { type: 'message.delta'; runId: string; messageId: string; text: string }
  | { type: 'message.completed'; runId: string; messageId: string; text: string }
  | { type: 'tool'; tool: AgentTool }
  | { type: 'interaction'; interaction: AgentInteraction }
  | { type: 'interaction.resolved'; runId: string; interactionId: string }
  | { type: 'turn.completed'; runId: string; outcome: 'completed' | 'interrupted' | 'failed'; error?: string }
  | { type: 'process.exited'; runId: string | null; error: string };
export interface AgentRuntimeOptions {
  cwd: string; nativeContextId: string | null; executablePath?: string;
  onEvent: (event: AgentEngineEvent) => void;
}
export interface AgentRuntime {
  readonly engine: AgentEngineKind;
  startTurn(input: { runId: string; text: string; model?: string }): Promise<void>;
  respond(interactionId: string, answer: AgentAnswer): Promise<void>;
  interrupt(runId: string): Promise<void>;
  close(): Promise<void>;
}
export interface AgentSnapshot {
  sessionId: string; messages: AgentMessage[]; interactions: AgentInteraction[]; tools: AgentTool[];
  model?: string | null;
}
export interface AgentModel { id: string; label: string; isDefault: boolean }
export type AgentDetector = (executablePath?: string) => Promise<EngineAvailability>;
