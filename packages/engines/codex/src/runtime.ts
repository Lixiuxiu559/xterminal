import { childInputFd, guardProcess, type ProcessGuard } from '../../shared/src/process-guard.ts';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { AgentRuntime, AgentRuntimeOptions, AgentEngineEvent, AgentAnswer, AgentInteraction } from '../../../protocol/src/agent.ts';
import type { EngineAvailability } from '../../../protocol/src/desktop.ts';
import type { AgentModel } from '../../../protocol/src/agent.ts';

type ObjectValue = Record<string, any>;
type RpcId = string | number;
type Pending = { method: string; resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Interaction = { rpcId: RpcId; method: string; runId: string; turnId: string; public: AgentInteraction };
type ActiveTurn = { runId: string; turnId: string | null; pendingStop: boolean; interruptPromise?: Promise<void> };
interface TestDependencies { spawn?: () => ChildProcessWithoutNullStreams; rpcTimeoutMs?: number; onDiagnostic?: (value: { category: string; httpStatus: number | null }) => void }
const MAX_FRAME = 4 * 1024 * 1024;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function failureDescription(raw: unknown): { summary: string; category: string; httpStatus: number | null } {
  const error = object(raw); const info = error.codexErrorInfo;
  const kind = typeof info === 'string' ? info : Object.keys(object(info))[0] ?? 'Unknown';
  const message = text(error.message).toLowerCase();
  let category = 'UNKNOWN'; let summary = 'Codex 轮次执行失败，请检查官方 CLI 的服务状态';
  if (/UsageLimit|quota|usage limit|rate limit|insufficient/.test(kind + message)) { category = 'USAGE_LIMIT'; summary = 'Codex 使用额度或请求速率达到上限，请检查账户状态'; }
  else if (/Unauthorized|unauthorized|authentication|401|403|invalid.api.key/.test(kind + message)) { category = 'AUTHENTICATION'; summary = 'Codex 模型服务认证失败，请通过官方 CLI 检查登录或提供方配置'; }
  else if (/model/.test(message) && /not found|not supported|unsupported|does not exist|access/.test(message)) { category = 'MODEL_UNAVAILABLE'; summary = 'Codex 当前模型不可用，请在会话的模型选项中选择有权限的模型'; }
  else if (/ContextWindow|context.window|context length/.test(kind + message)) { category = 'CONTEXT_LIMIT'; summary = 'Codex 上下文超过模型限制，请新建会话或在官方 CLI 中整理上下文'; }
  else if (/HttpConnection|ResponseStream|connection|network|stream|timeout|timed out/.test(kind + message)) { category = 'CONNECTION'; summary = 'Codex 与模型服务的连接失败，请检查网络和提供方地址'; }
  else if (/BadRequest|bad request/.test(kind + message)) { category = 'BAD_REQUEST'; summary = 'Codex 模型服务拒绝了请求，请检查官方 CLI 的模型与提供方配置'; }
  const nested = object(object(info)[kind]);
  const status = error.httpStatusCode ?? object(info).httpStatusCode ?? nested.httpStatusCode;
  return { summary, category, httpStatus: typeof status === 'number' && Number.isInteger(status) ? status : null };
}

export async function detectCodex(executablePath = 'codex'): Promise<EngineAvailability> {
  return new Promise((resolve) => {
    execFile(executablePath, ['--version'], { timeout: 5000, maxBuffer: 16384, encoding: 'utf8' }, (error, stdout) => {
      const version = /codex(?:-cli)?\s+([\d.]+[^\s]*)/.exec(stdout)?.[1] ?? null;
      resolve({ engine: 'codex', available: !error && !!version, version,
        reason: error || !version ? '无法运行 Codex，请先安装官方 CLI 并完成登录' : null });
    });
  });
}

/** Codex 0.157 app-server JSONL transport; one process and native thread per runtime. */
export class CodexRuntime implements AgentRuntime {
  readonly engine = 'codex' as const;
  readonly #options: AgentRuntimeOptions;
  readonly #deps: TestDependencies;
  #child?: ChildProcessWithoutNullStreams;
  #initializing?: Promise<void>;
  #threadId: string | null = null;
  #active: ActiveTurn | null = null;
  #usedRuns = new Set<string>();
  #pending = new Map<RpcId, Pending>();
  #interactions = new Map<string, Interaction>();
  #requestIds = new Set<RpcId>();
  #earlyFrames: ObjectValue[] = [];
  #earlyBytes = 0;
  #buffer = '';
  #rpcSequence = 0;
  #closing = false;
  #exited = false;
  #guard?: ProcessGuard;
  #failure: string | null = null;
  #turnError: string | null = null;
  #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #termTimer?: ReturnType<typeof setTimeout>;
  #killTimer?: ReturnType<typeof setTimeout>;

  constructor(options: AgentRuntimeOptions, testDependencies: TestDependencies = {}) {
    this.#options = options;
    this.#deps = testDependencies;
    this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });
  }

  /** Also useful for a no-model initialize/account/thread smoke. */
  initialize(): Promise<void> {
    if (this.#closing || this.#exited) return Promise.reject(new Error('Codex 进程已关闭'));
    return this.#initializing ??= this.#initialize();
  }

  async #initialize(): Promise<void> {
    try {
      this.#child = this.#deps.spawn?.() ?? spawn(this.#options.executablePath ?? 'codex', ['app-server', '--listen', 'stdio://'], {
        cwd: this.#options.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
      const child = this.#child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.#receive(chunk));
      child.stderr.resume(); // Drain independently; never persist or forward stderr.
      child.stdin.on('error', () => this.#fatal('Codex 通信管道失败'));
      child.stdout.on('error', () => this.#fatal('Codex 输出管道失败'));
      child.on('error', () => {
        if (!child.pid) this.#didExit('无法启动 Codex 进程');
        else this.#fatal('Codex 进程错误');
      });
      child.once('exit', () => this.#didExit('Codex 进程已退出'));
      if (!this.#deps.spawn && child.pid) {
        this.#guard = guardProcess(child.pid, () => this.#fatal('无法建立 Codex 进程监护'), childInputFd(child));
        await this.#guard.ready;
      }
      await this.#rpc('initialize', { clientInfo: { name: 'xterminal', title: 'XTerminal', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.#write({ method: 'initialized' });
      const account = await this.#rpc('account/read', { refreshToken: false });
      // Only inspect whether authentication exists; discard all account details.
      if (account.requiresOpenaiAuth === true && !account.account) throw new Error('Codex 尚未登录，请使用官方 CLI 登录');
      const config = { cwd: this.#options.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
      const response = this.#options.nativeContextId
        ? await this.#rpc('thread/resume', { ...config, threadId: this.#options.nativeContextId, excludeTurns: true })
        : await this.#rpc('thread/start', config);
      this.#threadId = text(object(response.thread).id);
      if (!this.#threadId || (this.#options.nativeContextId && this.#threadId !== this.#options.nativeContextId)) throw new Error('Codex 返回的上下文不匹配');
    } catch (error) {
      void this.close();
      throw error;
    }
  }

  async models(): Promise<AgentModel[]> {
    await this.initialize();
    const response = await this.#rpc('model/list', { limit: 100, cursor: null, includeHidden: false });
    if (!Array.isArray(response.data)) throw new Error('Codex 未返回模型列表');
    return response.data.filter((item: ObjectValue) => typeof item.id === 'string').map((item: ObjectValue) => ({ id: item.id, label: text(item.displayName) || item.id, isDefault: item.isDefault === true }));
  }
  async startTurn(input: { runId: string; text: string; model?: string }): Promise<void> {
    if (!input.runId || !input.text.trim() || Buffer.byteLength(input.text) > 256 * 1024) throw new Error('Codex 轮次输入无效');
    if (this.#active || this.#usedRuns.has(input.runId)) throw new Error('Codex 已有活动轮次或运行 ID 已使用');
    const active: ActiveTurn = { runId: input.runId, turnId: null, pendingStop: false };
    this.#active = active;
    this.#turnError = null;
    this.#requestIds.clear();
    this.#usedRuns.add(input.runId);
    if (this.#usedRuns.size > 4096) this.#usedRuns.delete(this.#usedRuns.values().next().value!);
    try {
      await this.initialize();
      if (this.#closing || !this.#active) throw new Error('Codex 进程已关闭');
      this.#emit({ type: 'context', runId: input.runId, nativeContextId: this.#threadId! });
      if (active.pendingStop) {
        // No turn/start was sent: the prompt has never been delivered to a model.
        this.#active = null;
        this.#emit({ type: 'turn.completed', runId: active.runId, outcome: 'interrupted' });
        return;
      }
      const response = await this.#rpc('turn/start', {
        threadId: this.#threadId, input: [{ type: 'text', text: input.text, text_elements: [] }],
        ...(input.model ? { model: input.model } : {}),
      });
      const turnId = text(object(response.turn).id);
      if (!turnId || !this.#active) throw new Error('Codex 未返回有效轮次');
      active.turnId = turnId;
      const early = this.#earlyFrames;
      this.#earlyFrames = []; this.#earlyBytes = 0;
      for (const frame of early) this.#dispatch(frame);
      if (this.#active === active && active.pendingStop) {
        // Acceptance arrived after the user stopped. Interrupt the exact native
        // turn, and keep its outcome pending until turn/completed arrives.
        void this.#sendInterrupt(active).catch(() => this.#fatal('Codex 中断请求失败，正在关闭运行实例'));
      }
    } catch (error) {
      if (this.#active === active) this.#active = null;
      this.#earlyFrames = []; this.#earlyBytes = 0;
      throw error;
    }
  }

  async respond(interactionId: string, answer: AgentAnswer): Promise<void> {
    const pending = this.#interactions.get(interactionId);
    if (!pending || pending.runId !== this.#active?.runId || pending.turnId !== this.#active.turnId || this.#closing) throw new Error('交互请求已失效');
    if (!pending.public.actions.includes(answer.action)) throw new Error('该交互不支持此回答');
    let result: ObjectValue;
    if (pending.public.kind === 'permission') {
      result = { decision: answer.action === 'allow-once' ? 'accept' : answer.action === 'deny' ? 'decline' : 'cancel' };
    } else if (pending.public.kind === 'question' && answer.action === 'submit') {
      const answers: Record<string, { answers: string[] }> = Object.create(null);
      for (const question of pending.public.questions ?? []) {
        const values = answer.answers?.[question.id];
        if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value.length > 16384)) throw new Error('问题回答不完整');
        answers[question.id] = { answers: values };
      }
      result = { answers };
    } else {
      this.#interactions.delete(interactionId);
      this.#write({ id: pending.rpcId, error: { code: -32800, message: 'User cancelled request' } });
      this.#emit({ type: 'interaction.resolved', runId: pending.runId, interactionId });
      await this.interrupt(pending.runId);
      return;
    }
    this.#interactions.delete(interactionId);
    this.#write({ id: pending.rpcId, result });
    this.#emit({ type: 'interaction.resolved', runId: pending.runId, interactionId });
  }

  async interrupt(runId: string): Promise<void> {
    const active = this.#active;
    if (!active || active.runId !== runId || this.#closing) throw new Error('Codex 运行实例已失效');
    active.pendingStop = true;
    if (!active.turnId) return;
    await this.#sendInterrupt(active);
    // Only turn/completed confirms interruption; an RPC acknowledgement is not completion.
  }

  #sendInterrupt(active: ActiveTurn): Promise<void> {
    return active.interruptPromise ??= this.#rpc('turn/interrupt', {
      threadId: this.#threadId, turnId: active.turnId,
    }).then(() => undefined);
  }

  close(): Promise<void> {
    if (this.#closing || this.#exited) return this.#exitPromise;
    this.#closing = true;
    this.#rejectInteractions();
    if (!this.#child) { this.#exited = true; this.#resolveExit(); return this.#exitPromise; }
    this.#rejectPending(new Error('Codex 进程正在关闭'));
    this.#child.stdin.end();
    this.#termTimer = setTimeout(() => { if (!this.#exited) this.#child?.kill('SIGTERM'); }, 300);
    this.#killTimer = setTimeout(() => { if (!this.#exited) this.#child?.kill('SIGKILL'); }, 1800);
    return this.#exitPromise;
  }

  #emit(event: AgentEngineEvent): void { try { this.#options.onEvent(event); } catch { /* observers cannot corrupt transport */ } }
  #write(frame: ObjectValue): void {
    if (!this.#child || this.#exited || this.#child.stdin.destroyed) throw new Error('Codex 通信管道已关闭');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME || this.#child.stdin.writableLength > MAX_FRAME) throw new Error('Codex 发送缓冲超过上限');
    this.#child.stdin.write(line);
  }
  #rpc(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (this.#closing || this.#pending.size >= 64) return Promise.reject(new Error('Codex 不再接收请求'));
    const id = `client-${++this.#rpcSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id); reject(new Error(`Codex 请求超时：${method}`));
        this.#fatal('Codex 协议请求超时，结果不确定');
      }, this.#deps.rpcTimeoutMs ?? 20000);
      this.#pending.set(id, { method, resolve, reject, timer });
      try { this.#write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  #receive(chunk: string): void {
    if (this.#exited || this.#closing) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME * 2) { this.#fatal('Codex 接收缓冲超过上限'); return; }
    let end: number;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) { this.#fatal('Codex 协议帧超过上限'); return; }
      if (!line.trim()) continue;
      try { this.#handle(object(JSON.parse(line))); }
      catch { this.#fatal('Codex 返回无效协议帧'); return; }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME) this.#fatal('Codex 协议帧超过上限');
  }
  #handle(frame: ObjectValue): void {
    if (frame.id !== undefined && !frame.method) {
      const pending = this.#pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.#pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(`Codex 拒绝了协议请求：${pending.method}`));
      else pending.resolve(object(frame.result));
      return;
    }
    const params = object(frame.params);
    if (this.#active && this.#active.turnId === null && this.#threadId && params.threadId === this.#threadId && !this.#closing) {
      this.#earlyBytes += Buffer.byteLength(JSON.stringify(frame));
      if (this.#earlyFrames.length >= 256 || this.#earlyBytes > MAX_FRAME) { this.#fatal('Codex 早到事件超过上限'); return; }
      this.#earlyFrames.push(frame);
      return;
    }
    this.#dispatch(frame);
  }
  #dispatch(frame: ObjectValue): void {
    const params = object(frame.params);
    const active = this.#active;
    const turnId = text(params.turnId) || text(object(params.turn).id);
    const current = !!active?.turnId && params.threadId === this.#threadId && turnId === active.turnId;
    if (frame.id !== undefined && frame.method) {
      if (!current || this.#closing) {
        this.#write({ id: frame.id, error: { code: -32800, message: 'Request belongs to an inactive turn' } }); return;
      }
      this.#request(frame, params, active!); return;
    }
    if (!current || !active) return;
    const runId = active.runId;
    if (frame.method === 'error') {
      const failure = failureDescription(params.error);
      this.#turnError = failure.summary;
      this.#deps.onDiagnostic?.({ category: failure.category, httpStatus: failure.httpStatus });
    } else if (frame.method === 'item/agentMessage/delta' && typeof params.delta === 'string' && typeof params.itemId === 'string') {
      this.#emit({ type: 'message.delta', runId, messageId: `${runId}:${params.itemId}`, text: params.delta });
    } else if (frame.method === 'item/completed' || frame.method === 'item/started') {
      const item = object(params.item);
      if (frame.method === 'item/completed' && item.type === 'agentMessage' && typeof item.id === 'string') {
        this.#emit({ type: 'message.completed', runId, messageId: `${runId}:${item.id}`, text: text(item.text) });
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) && typeof item.id === 'string') {
        this.#emit({ type: 'tool', tool: { id: `${runId}:${item.id}`, runId, title: item.type,
          detail: text(item.command) || text(item.tool), state: ['failed', 'declined'].includes(item.status) ? 'failed' : frame.method === 'item/started' ? 'running' : 'completed' } });
      }
    } else if (frame.method === 'turn/completed') {
      const turn = object(params.turn);
      if (!['completed', 'interrupted', 'failed'].includes(turn.status)) { this.#fatal('Codex 返回无效轮次结果'); return; }
      this.#rejectInteractions();
      this.#active = null;
      const failure = turn.error ? failureDescription(turn.error) : null;
      if (failure) this.#deps.onDiagnostic?.({ category: failure.category, httpStatus: failure.httpStatus });
      this.#emit({ type: 'turn.completed', runId, outcome: turn.status, ...(turn.status === 'failed' ? { error: failure?.summary ?? this.#turnError ?? 'Codex 轮次执行失败' } : {}) });
    }
  }
  #request(frame: ObjectValue, params: ObjectValue, active: { runId: string; turnId: string | null }): void {
    if (typeof frame.id !== 'string' && typeof frame.id !== 'number') throw new Error('Invalid request id');
    if (this.#requestIds.has(frame.id)) return;
    if (this.#interactions.size >= 64 || this.#requestIds.size >= 4096) { this.#fatal('Codex 交互请求超过上限'); return; }
    this.#requestIds.add(frame.id);
    const id = randomUUID();
    const method = text(frame.method);
    let interaction: AgentInteraction;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      interaction = { id, runId: active.runId, kind: 'permission', title: method.includes('commandExecution') ? '允许执行命令？' : '允许修改文件？',
        detail: [text(params.command), text(params.reason), text(params.cwd)].filter(Boolean).join('\n'), actions: ['allow-once', 'deny', 'cancel-turn'] };
    } else if (method === 'item/tool/requestUserInput' && Array.isArray(params.questions) && !params.questions.some((question: ObjectValue) => question.isSecret)) {
      interaction = { id, runId: active.runId, kind: 'question', title: 'Codex 需要补充信息', detail: '', actions: ['submit', 'cancel-turn'],
        questions: params.questions.map((raw: unknown) => {
          const question = object(raw);
          return { id: text(question.id), header: text(question.header), question: text(question.question), options: Array.isArray(question.options)
            ? question.options.map((option: ObjectValue) => ({ label: text(option.label), description: text(option.description) })) : [] };
        }) };
    } else {
      interaction = { id, runId: active.runId, kind: 'unsupported', title: '暂不支持此 Codex 交互', detail: method, actions: ['cancel-turn'] };
      this.#write({ id: frame.id, error: { code: -32601, message: 'Unsupported client request' } });
      this.#emit({ type: 'interaction', interaction });
      this.#emit({ type: 'interaction.resolved', runId: active.runId, interactionId: id });
      return;
    }
    this.#interactions.set(id, { rpcId: frame.id, method, runId: active.runId, turnId: active.turnId!, public: interaction });
    this.#emit({ type: 'interaction', interaction });
  }
  #rejectInteractions(): void {
    const interactions = [...this.#interactions];
    this.#interactions.clear();
    for (const [id, pending] of interactions) {
      try { this.#write({ id: pending.rpcId, error: { code: -32800, message: 'Turn ended or runtime closed' } }); } catch { /* process may be gone */ }
      this.#emit({ type: 'interaction.resolved', runId: pending.runId, interactionId: id });
    }
  }
  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
  #fatal(reason: string): void {
    if (this.#exited || this.#closing) return;
    this.#failure = reason;
    this.#rejectPending(new Error(reason));
    void this.close();
  }
  #didExit(reason: string): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#guard?.dispose();
    clearTimeout(this.#termTimer); clearTimeout(this.#killTimer);
    reason = this.#failure ?? reason;
    const runId = this.#active?.runId ?? null;
    this.#rejectPending(new Error(reason)); this.#rejectInteractions();
    this.#active = null; this.#buffer = ''; this.#earlyFrames = []; this.#earlyBytes = 0;
    this.#emit({ type: 'process.exited', runId, error: reason });
    this.#resolveExit();
  }
}

export async function listCodexModels(executablePath?: string): Promise<AgentModel[]> {
  const runtime = new CodexRuntime({ cwd: tmpdir(), nativeContextId: null, executablePath, onEvent: () => {} });
  try { return await runtime.models(); } finally { await runtime.close(); }
}
