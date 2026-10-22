import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Store } from '../../storage/src/store.ts';
import type { AppSession, EngineAvailability, SessionRecord } from '../../protocol/src/desktop.ts';
import type { AgentAnswer, AgentEngineEvent, AgentInteraction, AgentMessage, AgentRuntime, AgentRuntimeOptions, AgentSnapshot, AgentTool, AgentModel } from '../../protocol/src/agent.ts';
import type { AgentEngineKind } from '../../protocol/src/index.ts';
import { CodexRuntime, detectCodex, listCodexModels } from '../../engines/codex/src/runtime.ts';
import { ClaudeRuntime, detectClaude } from '../../engines/claude/src/runtime.ts';
import { HostError } from './validation.ts';
import { isolatedEngineTargets, missingEngineReason, resolveEngineTargets, type EngineTarget, type EngineTargets } from './engine-environment.ts';

type State = Pick<AppSession, 'state' | 'runId' | 'error'>;
export interface AgentServices {
  createRuntime: (engine: AgentEngineKind, options: AgentRuntimeOptions) => AgentRuntime;
  locate: () => Promise<EngineTargets>;
  detect: (targets: EngineTargets) => Promise<EngineAvailability[]>;
  listModels: (target: EngineTarget) => Promise<AgentModel[]>;
}
interface Options {
  store: Store; instanceId: string; shell?: string;
  state: (sessionId: string, value: State) => void;
  catalog: () => void; emit: (snapshot: AgentSnapshot) => void;
}
export class AgentSessions {
  private readonly options: Options;
  private readonly services: AgentServices;
  private targets = isolatedEngineTargets();
  private availability: EngineAvailability[] = ['claude', 'codex'].map(engine => ({ engine: engine as AgentEngineKind, available: false, version: null, reason: '正在检测本机引擎' }));
  private readonly runtimes = new Map<string, { token: string; runtime: AgentRuntime }>();
  private readonly active = new Map<string, { runId: string; root: string }>();
  private readonly locks = new Map<string, string>();
  private readonly messages = new Map<string, AgentMessage[]>();
  private readonly interactions = new Map<string, Map<string, AgentInteraction>>();
  private readonly tools = new Map<string, Map<string, AgentTool>>();
  private readonly answering = new Set<string>();
  private readonly dirty = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly pendingFinish = new Map<string, 'completed' | 'interrupted' | 'failed'>();
  private closing = false;
  private storageFault = false;
  constructor(options: Options, services: Partial<AgentServices> = {}) {
    this.options = options;
    this.services = {
      createRuntime: services.createRuntime ?? ((engine, options) => {
        if (!options.executablePath) throw new HostError('ENGINE_UNAVAILABLE', '引擎路径未解析，请明确退出并重启应用。');
        return engine === 'codex' ? new CodexRuntime(options) : new ClaudeRuntime(options);
      }),
      // Fixture detectors never implicitly execute the user's login shell.
      locate: services.locate ?? (services.detect ? async () => isolatedEngineTargets() : () => resolveEngineTargets({ shell: options.shell })),
      detect: services.detect ?? (targets => Promise.all((['claude', 'codex'] as const).map(engine => {
        const target = targets[engine];
        return target.path ? (engine === 'claude' ? detectClaude(target.path, { env: target.env }) : detectCodex(target.path, { env: target.env }))
          : Promise.resolve({ engine, available: false, version: null, reason: missingEngineReason(engine, target) });
      }))),
      listModels: services.listModels ?? (target => {
        if (!target.path) throw new HostError('ENGINE_UNAVAILABLE', missingEngineReason('codex', target));
        return listCodexModels(target.path, target.env);
      }),
    };
  }
  async initialize(): Promise<void> { this.targets = await this.services.locate(); this.availability = await this.services.detect(this.targets); }
  capabilities(): EngineAvailability[] { return this.availability.map(item => ({ ...item })); }
  private record(id: string): SessionRecord {
    const session = this.options.store.getSession(id);
    if (!session || session.engine === 'shell') throw new HostError('INVALID_ENGINE', '此操作需要 Agent 会话');
    return session;
  }
  snapshot(id: string): AgentSnapshot {
    this.record(id);
    if (!this.messages.has(id)) this.messages.set(id, this.options.store.listAgentMessages(id));
    return { sessionId: id, messages: this.messages.get(id)!.map(message => ({ ...message })), interactions: [...(this.interactions.get(id)?.values() ?? [])], tools: [...(this.tools.get(id)?.values() ?? [])], model: this.options.store.getSetting<string>(`agent.model:${id}`) };
  }
  private publish(id: string): void { this.options.emit(this.snapshot(id)); }
  private flush(id: string): void {
    clearTimeout(this.timers.get(id)); this.timers.delete(id);
    const dirty = this.dirty.get(id);
    if (!dirty) return;
    for (const messageId of [...dirty]) {
      const message = this.messages.get(id)?.find(item => item.id === messageId);
      if (message) this.options.store.saveAgentMessage(id, message);
      dirty.delete(messageId);
    }
    if (!dirty.size) this.dirty.delete(id);
  }
  private defer(id: string, messageId: string): void {
    const dirty = this.dirty.get(id) ?? new Set<string>(); dirty.add(messageId); this.dirty.set(id, dirty);
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      try { this.flush(id); this.publish(id); }
      catch (error) { this.failedStorage(id, error); }
    }, 50));
  }
  private failedStorage(id: string, error: unknown): void {
    this.storageFault = true;
    const run = this.active.get(id);
    this.options.state(id, { state: 'error', runId: run?.runId ?? null, error: `保存记录失败：${(error as Error).message}` });
    this.options.catalog();
    if (run) void this.runtimes.get(id)?.runtime.interrupt(run.runId).catch(() => {});
  }
  models() {
    const capability = this.availability.find(item => item.engine === 'codex');
    if (!capability?.available) throw new HostError('ENGINE_UNAVAILABLE', capability?.reason ?? 'Codex 不可用');
    return this.services.listModels(this.targets.codex);
  }
  start(id: string, text: string, commandId: string, model?: string, principalId = 'desktop'): void {
    const record = this.record(id);
    if (this.options.store.agentReceipt(id, commandId, text, model, principalId)) return;
    if (model && record.engine !== 'codex') throw new HostError('INVALID_ENGINE', '当前仅 Codex 支持逐轮选择模型');
    if (this.closing || this.storageFault) throw new HostError('STORAGE_UNAVAILABLE', '当前不能启动新任务，请检查存储与退出状态');
    const capability = this.availability.find(item => item.engine === record.engine);
    if (!capability?.available) throw new HostError('ENGINE_UNAVAILABLE', capability?.reason ?? '引擎不可用');
    if (this.active.has(id)) throw new HostError('SESSION_BUSY', '当前会话仍在执行');
    const root = realpathSync(record.initialCwd);
    if (this.locks.has(root)) throw new HostError('PROJECT_BUSY', '同一项目已有 Agent 正在执行，请先完成或停止原任务');
    const runId = randomUUID();
    this.options.store.acceptAgentTurn({ sessionId: id, runId, commandId, hostInstanceId: this.options.instanceId, text, model, principalId });
    this.messages.set(id, this.options.store.listAgentMessages(id));
    this.active.set(id, { runId, root }); this.locks.set(root, runId);
    this.interactions.set(id, new Map()); this.tools.set(id, new Map());
    this.options.state(id, { state: 'starting', runId, error: null });
    this.options.catalog(); this.publish(id);
    try {
      let handle = this.runtimes.get(id);
      if (!handle) {
        const token = randomUUID();
        const target = this.targets[record.engine as AgentEngineKind];
        const runtime = this.services.createRuntime(record.engine as AgentEngineKind, { cwd: root, nativeContextId: this.options.store.getEngineContext(id),
          executablePath: target.path ?? undefined, env: { ...target.env },
          onEvent: event => { if (this.runtimes.get(id)?.token === token) this.event(id, event); },
        });
        handle = { token, runtime }; this.runtimes.set(id, handle);
      }
      this.options.store.markDispatched(id, commandId, principalId);
      void handle.runtime.startTurn({ runId, text, ...(model ? { model } : {}) }).then(() => {
        if (this.active.get(id)?.runId !== runId || this.interactions.get(id)?.size) return;
        // A stop may have arrived while initialize/thread loading was pending.
        if (this.stopping.has(runId)) return;
        this.options.state(id, { state: 'running', runId, error: null }); this.options.catalog();
      }).catch(error => this.event(id, { type: 'turn.completed', runId, outcome: 'failed', error: (error as Error).message }));
    } catch (error) { this.event(id, { type: 'turn.completed', runId, outcome: 'failed', error: (error as Error).message }); }
  }
  private readonly stopping = new Set<string>();
  async stop(id: string, runId: string): Promise<void> {
    if (this.active.get(id)?.runId !== runId) throw new HostError('RUN_MISMATCH', '任务已结束或运行实例已变化');
    const runtime = this.runtimes.get(id)?.runtime;
    if (!runtime) throw new HostError('ENGINE_EXITED', '引擎已退出');
    this.stopping.add(runId);
    this.options.state(id, { state: 'stopping', runId, error: null }); this.options.catalog();
    await runtime.interrupt(runId);
  }
  async respond(id: string, runId: string, interactionId: string, answer: AgentAnswer): Promise<void> {
    if (this.active.get(id)?.runId !== runId) throw new HostError('INTERACTION_EXPIRED', '此交互已不属于当前任务');
    const interaction = this.interactions.get(id)?.get(interactionId);
    if (!interaction || this.answering.has(interactionId)) throw new HostError('INTERACTION_EXPIRED', '此交互已被处理');
    if (!interaction.actions.includes(answer.action)) throw new HostError('INVALID_RESPONSE', '不支持此操作');
    this.answering.add(interactionId);
    if (answer.action === 'cancel-turn') {
      this.stopping.add(runId); this.options.state(id, { state: 'stopping', runId, error: null }); this.options.catalog();
    }
    try {
      await this.runtimes.get(id)!.runtime.respond(interactionId, answer);
      this.interactions.get(id)?.delete(interactionId);
      if (this.active.get(id)?.runId === runId && !this.interactions.get(id)?.size && !this.stopping.has(runId)) {
        this.options.state(id, { state: 'running', runId, error: null }); this.options.catalog();
      }
      this.publish(id);
    } finally { this.answering.delete(interactionId); }
  }
  private event(id: string, event: AgentEngineEvent): void {
    const runId = event.type === 'tool' ? event.tool.runId : event.type === 'interaction' ? event.interaction.runId : event.runId;
    if (event.type === 'process.exited') {
      this.runtimes.delete(id);
      const active = this.active.get(id);
      if (active && (!event.runId || event.runId === active.runId)) this.event(id, { type: 'turn.completed', runId: active.runId, outcome: 'interrupted', error: event.error });
      return;
    }
    if (!runId || this.active.get(id)?.runId !== runId) return;
    try {
      switch (event.type) {
        case 'context': this.options.store.saveEngineContext(id, event.nativeContextId, this.availability.find(item => item.engine === this.record(id).engine)?.version ?? 'unknown'); break;
        case 'message.delta':
        case 'message.completed': {
          const messages = this.messages.get(id)!;
          const messageId = `${runId}:${event.messageId}`;
          let message = messages.find(item => item.id === messageId);
          if (!message) { message = { id: messageId, runId, role: 'assistant', text: '', status: 'streaming', createdAt: new Date().toISOString() }; messages.push(message); }
          if (event.type === 'message.delta' && message.status === 'completed') break;
          if (event.type === 'message.delta') message.text += event.text;
          else { message.text = event.text; message.status = 'completed'; }
          this.defer(id, messageId); break;
        }
        case 'tool': this.tools.get(id)?.set(event.tool.id, event.tool); this.flush(id); this.publish(id); break;
        case 'interaction':
          if (this.stopping.has(runId)) break;
          this.interactions.get(id)?.set(event.interaction.id, event.interaction);
          this.options.state(id, { state: 'waiting', runId, error: null });
          this.flush(id); this.publish(id); this.options.catalog(); break;
        case 'interaction.resolved':
          this.interactions.get(id)?.delete(event.interactionId);
          if (!this.interactions.get(id)?.size && !this.stopping.has(runId)) {
            this.options.state(id, { state: 'running', runId, error: null }); this.options.catalog();
          }
          this.publish(id); break;
        case 'turn.completed': {
          for (const message of this.messages.get(id) ?? []) if (message.runId === runId && message.status === 'streaming') {
            message.status = event.outcome === 'completed' ? 'completed' : 'interrupted'; this.defer(id, message.id);
          }
          this.pendingFinish.set(runId, event.outcome);
          const run = this.active.get(id)!;
          this.active.delete(id); if (this.locks.get(run.root) === runId) this.locks.delete(run.root);
          this.stopping.delete(runId); this.interactions.get(id)?.clear();
          this.options.state(id, { state: event.outcome === 'failed' ? 'error' : event.outcome === 'interrupted' ? 'interrupted' : 'idle', runId: null, error: event.error ?? null });
          this.flush(id); this.options.store.finishRun(runId, event.outcome); this.pendingFinish.delete(runId);
          this.publish(id); this.options.catalog(); break;
        }
      }
    } catch (error) { this.failedStorage(id, error); }
  }
  activeCount(): number { return this.active.size; }
  async close(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.runtimes.values()].map(handle => handle.runtime.close()));
    if (results.some(result => result.status === 'rejected')) throw new HostError('SHUTDOWN_FAILED', '仍有 Agent 进程未确认退出');
    // A runtime must emit terminal outcome or process.exited before close resolves.
    if (this.active.size) throw new HostError('SHUTDOWN_FAILED', 'Agent 尚未确认轮次结束');
    for (const id of this.dirty.keys()) this.flush(id);
    for (const [runId, outcome] of this.pendingFinish) { this.options.store.finishRun(runId, outcome); this.pendingFinish.delete(runId); }
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.runtimes.clear();
  }
}
