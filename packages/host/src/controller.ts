import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { Store } from '../../storage/src/store.ts';
import { ShellRuntime, type ShellRuntimeOptions } from '../../engines/shell/src/runtime.ts';
import type { AppEvent, AppSession, Bootstrap, RpcResponse, SessionRecord } from '../../protocol/src/desktop.ts';
import { HostError, parameters, validateRequest } from './validation.ts';
import { AgentSessions, type AgentServices } from './agents.ts';
import { ControlManager } from '../../core/src/control-manager.ts';
import { LanController, type LanControllerServices } from './lan-controller.ts';

export interface HostOptions {
  dbPath: string; schemaPath: string; shell: string;
  uiPath?: string;
  emit: (event: AppEvent) => void;
}
interface HostServices {
  store: Store;
  createTerminal: (options: ShellRuntimeOptions) => ShellRuntime;
  agents: Partial<AgentServices>;
  lan: Partial<LanControllerServices>;
}
export class SessionHost {
  readonly instanceId = randomUUID();
  private readonly store: Store;
  private readonly terminals = new Map<string, ShellRuntime>();
  private readonly states = new Map<string, Pick<AppSession, 'state' | 'runId' | 'error'>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly unsavedExits = new Map<string, { status: 'exited' | 'failed'; errorCode?: string }>();
  private closing = false;
  private quiescing = false;
  private readonly options: HostOptions;
  private readonly createTerminal: HostServices['createTerminal'];
  private readonly agents: AgentSessions;
  private readonly controls: ControlManager;
  private readonly controlTimer: NodeJS.Timeout;
  private readonly lan: LanController;
  constructor(options: HostOptions, services: Partial<HostServices> = {}) {
    this.options = options;
    this.store = services.store ?? new Store(options.dbPath, options.schemaPath);
    this.createTerminal = services.createTerminal ?? (options => new ShellRuntime(options));
    this.store.recoverRuns();
    this.controls = new ControlManager(this.instanceId, () => this.changed());
    this.controlTimer = setInterval(() => this.controls.expire(), 1000);
    this.controlTimer.unref();
    this.lan = new LanController({ dataPath: dirname(options.dbPath), uiPath: options.uiPath ?? resolve('dist/ui'),
      repository: { list: () => this.store.listDevices(), upsert: device => this.store.upsertDevice(device) },
      execute: (principal, request) => this.handle(request, principal), bootstrap: principal => this.bootstrap(principal),
      changed: state => this.options.emit({ type: 'lan.changed', state }),
      onDeviceRevoked: principal => this.revokeControl(principal),
    }, services.lan);
    this.agents = new AgentSessions({ store: this.store, instanceId: this.instanceId,
      state: (id, state) => this.states.set(id, state), catalog: () => this.changed(),
      emit: snapshot => this.emit({ type: 'agent.changed', snapshot }),
    }, services.agents);
    // Recovery does not recreate processes or resend input.
  }
  async ready(): Promise<void> { await this.lan.initialize(); await this.agents.initialize(); }
  private emit(event: AppEvent): void { this.options.emit(event); this.lan.broadcast(event); }
  publicCertificatePath(): string | null { return this.lan.publicCertificatePath(); }
  private session(record: SessionRecord): AppSession {
    const known = this.states.get(record.id);
    const last = this.store.lastRun(record.id);
    return { ...record, control: this.controls.get(record.id), ...(known ?? {
      state: last?.status === 'interrupted' ? 'interrupted' : last?.status === 'failed' ? 'error' : last && record.engine === 'shell' ? 'exited' : 'idle',
      runId: null, error: last?.status === 'interrupted' ? record.engine === 'shell' ? '上次运行已中断，可明确启动新的终端' : '上次任务已中断，不会自动重发；可检查历史后继续' : null,
    }) };
  }
  bootstrap(principalId = 'desktop'): Bootstrap {
    let shellAvailable = false;
    try { if (isAbsolute(this.options.shell)) { accessSync(this.options.shell, constants.X_OK); shellAvailable = true; } } catch { /* capability describes failure */ }
    return {
      hostInstanceId: this.instanceId, principalId, projects: this.store.listProjects(), sessions: this.store.listSessions().map(s => this.session(s)),
      engines: [
        { engine: 'shell', available: shellAvailable, version: basename(this.options.shell), reason: shellAvailable ? null : '未找到可执行的本机 Shell' },
        ...this.agents.capabilities(),
      ],
    };
  }
  private changed(): void { this.emit({ type: 'catalog.changed', snapshot: this.bootstrap() }); }
  addProject(path: string) {
    if (this.closing || this.quiescing) throw new HostError('HOST_CLOSING', '应用正在准备退出');
    const project = this.store.addProject(path); this.changed(); return project;
  }
  private requireSession(id: string): SessionRecord {
    const session = this.store.getSession(id);
    if (!session) throw new HostError('SESSION_NOT_FOUND', '会话不存在');
    return session;
  }
  private terminal(id: string, runId?: string, epoch?: string): ShellRuntime {
    const session = this.requireSession(id);
    if (session.engine !== 'shell') throw new HostError('INVALID_ENGINE', '此操作仅支持 Shell');
    const runtime = this.terminals.get(id);
    if (!runtime || runtime.exited) throw new HostError('ENGINE_EXITED', '终端尚未启动或已经退出');
    if (runId && runId !== runtime.runId) throw new HostError('RUN_MISMATCH', '运行实例已变化');
    if (epoch && epoch !== runtime.terminalEpoch) throw new HostError('TERMINAL_EPOCH_MISMATCH', '终端已重新启动，请刷新');
    return runtime;
  }
  revokeControl(principalId: string): void { this.controls.revoke(principalId); }
  async handle(raw: unknown, principalId = 'desktop'): Promise<RpcResponse> {
    let id = typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string' ? raw.id : '';
    try {
      const request = validateRequest(raw); id = request.id;
      if (request.method.startsWith('lan.') && principalId !== 'desktop') throw new HostError('FORBIDDEN', '局域网设置仅能在电脑端管理');
      if (this.closing && !['bootstrap', 'shell.snapshot', 'agent.snapshot'].includes(request.method)) throw new HostError('HOST_CLOSING', '应用正在退出，暂不接收新操作');
      if (this.quiescing && !['bootstrap', 'shell.snapshot', 'agent.snapshot', 'control.renew'].includes(request.method)) throw new HostError('HOST_CLOSING', '正在确认退出，暂不接收新操作');
      if (this.unsavedExits.size && !['bootstrap', 'shell.snapshot', 'shell.terminate', 'agent.snapshot', 'agent.turn.stop'].includes(request.method)) throw new HostError('STORAGE_UNAVAILABLE', '运行记录保存失败，暂不接收新任务');
      const params = request.params as Record<string, unknown>;
      // Commands for one session execute serially; PTY callbacks remain independent.
      const key = String(params.sessionId ?? params.commandId ?? 'catalog');
      const previous = this.queues.get(key) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(() => {
        if (['shell.start', 'shell.input', 'shell.resize', 'shell.terminate', 'agent.turn.start', 'agent.turn.stop', 'agent.respond'].includes(request.method)) {
          this.controls.assert(String(params.sessionId), principalId, request.control);
        }
        return this.dispatch(request, principalId);
      });
      this.queues.set(key, operation);
      try { return { id, ok: true, result: await operation }; }
      finally { if (this.queues.get(key) === operation) this.queues.delete(key); }
    } catch (error) {
      const e = error as Error & { code?: string };
      return { id, ok: false, error: { code: e.code ?? 'OPERATION_FAILED', message: e.message || '操作失败' } };
    }
  }
  private async dispatch(request: ReturnType<typeof validateRequest>, principalId: string): Promise<unknown> {
    switch (request.method) {
      case 'lan.status': return this.lan.status();
      case 'lan.enable': return this.lan.enable(parameters(request, 'lan.enable').address);
      case 'lan.disable': return this.lan.disable();
      case 'lan.rotateCode': return this.lan.rotate();
      case 'lan.approve': return this.lan.approve(parameters(request, 'lan.approve').ticket);
      case 'lan.reject': return this.lan.reject(parameters(request, 'lan.reject').ticket);
      case 'lan.revoke': return this.lan.revoke(parameters(request, 'lan.revoke').deviceId);
      case 'lan.exportCertificate': throw new HostError('NATIVE_ACTION_REQUIRED', '请通过桌面原生对话框导出证书');
      case 'bootstrap': return this.bootstrap(principalId);
      case 'control.acquire': {
        const p = parameters(request, 'control.acquire'); this.requireSession(p.sessionId);
        return this.controls.acquire(p.sessionId, principalId);
      }
      case 'control.renew': return this.controls.renew(parameters(request, 'control.renew').sessionId, principalId, request.control);
      case 'control.release': this.controls.release(parameters(request, 'control.release').sessionId, principalId, request.control); return null;
      case 'session.create': {
        const p = parameters(request, 'session.create');
        const capability = this.bootstrap().engines.find(e => e.engine === p.engine);
        if (!capability?.available) throw new HostError('ENGINE_UNAVAILABLE', capability?.reason ?? '引擎不可用');
        const existed = this.store.getSession(p.commandId);
        const record = this.store.createSession({ id: p.commandId, projectId: p.projectId, engine: p.engine, title: p.title });
        if (!existed) this.controls.acquire(record.id, principalId);
        this.changed(); return this.session(record);
      }
      case 'session.rename': {
        const p = parameters(request, 'session.rename');
        const record = this.store.renameSession(p.sessionId, p.title, p.expectedRevision); this.changed(); return this.session(record);
      }
      case 'shell.start': {
        const p = parameters(request, 'shell.start');
        const record = this.requireSession(p.sessionId);
        if (record.engine !== 'shell') throw new HostError('INVALID_ENGINE', '此会话不是 Shell');
        if (this.terminals.has(record.id)) throw new HostError('SESSION_BUSY', '终端已经启动');
        const runId = randomUUID();
        this.store.beginRun({ id: runId, sessionId: record.id, hostInstanceId: this.instanceId });
        this.states.set(record.id, { state: 'starting', runId, error: null });
        try {
          const runtime = this.createTerminal({ sessionId: record.id, runId, cwd: record.initialCwd, shell: this.options.shell, cols: p.cols, rows: p.rows,
            onOutput: frame => this.emit(frame),
            onError: error => { this.states.set(record.id, { state: 'error', runId, error: error.message }); this.changed(); },
            onExit: result => {
              const intentional = this.closing || this.states.get(record.id)?.state === 'stopping';
              const failed = !intentional && result.exitCode !== 0;
              this.terminals.delete(record.id);
              this.states.set(record.id, { state: failed ? 'error' : 'exited', runId: null, error: failed ? `终端退出（${result.exitCode}）` : null });
              const exit = { status: failed ? 'failed' as const : 'exited' as const, errorCode: failed ? `EXIT_${result.exitCode}` : undefined };
              this.unsavedExits.set(runId, exit);
              try {
                this.store.finishRun(runId, exit.status, exit.errorCode);
                this.unsavedExits.delete(runId);
              } catch {
                this.states.set(record.id, { state: 'error', runId: null, error: '终端已结束，但运行记录保存失败；请检查磁盘空间' });
              }
              this.changed();
            },
          });
          this.terminals.set(record.id, runtime);
          await runtime.ready?.();
          this.states.set(record.id, { state: 'running', runId, error: null });
        } catch (error) {
          const failedRuntime = this.terminals.get(record.id);
          if (failedRuntime) await failedRuntime.terminate();
          this.store.finishRun(runId, 'failed', 'SPAWN_FAILED');
          this.states.set(record.id, { state: 'error', runId: null, error: (error as Error).message });
          this.changed(); throw error;
        }
        this.changed(); return this.session(record);
      }
      case 'shell.snapshot': {
        const p = parameters(request, 'shell.snapshot'); this.requireSession(p.sessionId);
        const runtime = this.terminals.get(p.sessionId); return runtime && !runtime.exited ? runtime.snapshot() : null;
      }
      case 'shell.input': {
        const p = parameters(request, 'shell.input'); this.terminal(p.sessionId, p.runId, p.terminalEpoch).input(p); return { written: true };
      }
      case 'shell.resize': {
        const p = parameters(request, 'shell.resize'); return this.terminal(p.sessionId, p.runId, p.terminalEpoch).resize(p.cols, p.rows);
      }
      case 'shell.terminate': {
        const p = parameters(request, 'shell.terminate'); const runtime = this.terminal(p.sessionId, p.runId);
        this.states.set(p.sessionId, { state: 'stopping', runId: p.runId, error: null }); this.changed();
        await runtime.terminate(); return this.session(this.requireSession(p.sessionId));
      }
      case 'agent.snapshot': return this.agents.snapshot(parameters(request, 'agent.snapshot').sessionId);
      case 'agent.turn.start': {
        const p = parameters(request, 'agent.turn.start'); this.agents.start(p.sessionId, p.text, p.commandId, p.model, principalId);
        return this.session(this.requireSession(p.sessionId));
      }
      case 'engine.models': return this.agents.models();
      case 'agent.turn.stop': {
        const p = parameters(request, 'agent.turn.stop'); await this.agents.stop(p.sessionId, p.runId);
        return this.session(this.requireSession(p.sessionId));
      }
      case 'agent.respond': {
        const p = parameters(request, 'agent.respond'); await this.agents.respond(p.sessionId, p.runId, p.interactionId, p.answer);
        return this.agents.snapshot(p.sessionId);
      }
    }
  }
  activeCount(): number { return this.terminals.size + this.agents.activeCount(); }
  async prepareShutdown(): Promise<Bootstrap> {
    this.quiescing = true;
    await Promise.allSettled([...this.queues.values()]);
    return this.bootstrap();
  }
  cancelShutdown(): void { if (!this.closing) this.quiescing = false; }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.queues.values()]);
    await this.lan.disable();
    const results = await Promise.allSettled([...this.terminals.values()].map(runtime => runtime.terminate()));
    if (results.some(result => result.status === 'rejected')) throw new HostError('SHUTDOWN_FAILED', '仍有终端未确认退出');
    await this.agents.close();
    for (const [runId, exit] of this.unsavedExits) {
      this.store.finishRun(runId, exit.status, exit.errorCode);
      this.unsavedExits.delete(runId);
    }
    clearInterval(this.controlTimer); this.store.close();
  }
}
