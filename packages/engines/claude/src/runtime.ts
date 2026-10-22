import { childInputFd, guardProcess, type ProcessGuard } from '../../shared/src/process-guard.ts';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { CanUseTool, Options, PermissionResult, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { cliQuery } from './cli-query.ts';
import type { AgentAnswer, AgentEngineEvent, AgentInteraction, AgentQuestion, AgentRuntime, AgentRuntimeOptions, AgentTool, AgentEnvironment } from '../../../protocol/src/agent.ts';
import type { EngineAvailability } from '../../../protocol/src/desktop.ts';

const runFile = promisify(execFile);
export async function detectClaude(executablePath = 'claude', options: { env?: AgentEnvironment } = {}): Promise<EngineAvailability> {
  let version: string | null = null;
  try {
    const { stdout } = await runFile(executablePath, ['--version'], { timeout: 5000, maxBuffer: 16_384, windowsHide: true, env: options.env });
    version = stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
    if (version !== '2.1.304') return { engine: 'claude', available: false, version, reason: `Claude CLI 版本不匹配：当前 ${version ?? '无法识别'}，本版本仅验证 2.1.304。` };
    const status = await runFile(executablePath, ['auth', 'status', '--json'], { timeout: 5000, maxBuffer: 16_384, windowsHide: true, env: options.env });
    const parsed: unknown = JSON.parse(status.stdout);
    const loggedIn = !!parsed && typeof parsed === 'object' && 'loggedIn' in parsed && parsed.loggedIn === true;
    return { engine: 'claude', available: loggedIn, version, reason: loggedIn ? null : '请先在官方 Claude Code CLI 完成登录；XTerminal 不收集登录凭据。' };
  } catch {
    return { engine: 'claude', available: false, version, reason: version ? 'Claude 官方登录状态无法确认，请在原 CLI 中检查登录。' : '未找到可执行的 Claude CLI，或版本探测失败。' };
  }
}

type QueryLike = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close'>;
export interface ClaudeTestDependencies {
  query?: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;
  spawn?: (options: SpawnOptions) => SpawnedProcess;
  timeoutMs?: number;
  guard?: typeof guardProcess;
}
function error(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function plain(value: unknown, limit = 2000): string {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/</g, '＜').replace(/>/g, '＞').slice(0, limit);
}
function summary(input: Record<string, unknown>): string {
  const fields = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url'];
  return plain(fields.filter(key => typeof input[key] === 'string').map(key => `${key}: ${String(input[key]).slice(0, 1200)}`).join('\n') || '工具请求（仅显示文本摘要）');
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(res => { resolve = res; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error('CLAUDE_TIMEOUT', message)), timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  push(value: SDKUserMessage): void { if (this.ended) throw error('ENGINE_EXITED', 'Claude 输入流已关闭'); this.values.push(value); this.wake?.(); }
  remove(uuid: string): boolean {
    const index = this.values.findIndex(value => value.uuid === uuid);
    if (index < 0) return false;
    this.values.splice(index, 1); return true;
  }
  end(): void { this.ended = true; this.values = []; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.ended) {
      const value = this.values.shift();
      if (value) { yield value; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}
type Turn = { queued?: boolean; id: string; uuid: ReturnType<typeof randomUUID>; done: ReturnType<typeof deferred>; outcome?: 'completed' | 'interrupted' | 'failed'; lastMessageId?: string; streamMessageId?: string };
type Pending = { interaction: AgentInteraction; input: Record<string, unknown>; resolve: (result: PermissionResult) => void; cleanup: () => void };

/** Uses the user's unmodified official CLI and its native authentication/configuration. */
export class ClaudeRuntime implements AgentRuntime {
  readonly engine = 'claude' as const;
  private readonly options: AgentRuntimeOptions;
  private readonly deps: ClaudeTestDependencies;
  private readonly prompts = new PromptQueue();
  private readonly abort = new AbortController();
  private query?: QueryLike;
  private reading?: Promise<void>;
  private process?: SpawnedProcess;
  private processEnded?: ReturnType<typeof deferred>;
  private turn?: Turn;
  private contextId: string | null;
  private readonly pending = new Map<string, Pending>();
  private readonly tools = new Map<string, AgentTool>();
  private closed = false;
  private failed = false;
  private closing?: Promise<void>;
  private emittedExit = false;
  private guard?: ProcessGuard;
  constructor(options: AgentRuntimeOptions, testdeps: ClaudeTestDependencies = {}) {
    if (!options.cwd) throw error('INVALID_CWD', 'Claude 工作目录不能为空');
    this.options = options; this.deps = testdeps; this.contextId = options.nativeContextId;
  }
  private emit(event: AgentEngineEvent): void { this.options.onEvent(event); }
  private spawnProcess = (options: SpawnOptions): SpawnedProcess => {
    const child: SpawnedProcess = this.deps.spawn ? this.deps.spawn(options) : spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true,
    });
    this.process = child; this.processEnded = deferred();
    const settled = () => { this.guard?.dispose(); this.processEnded?.resolve(); };
    child.once('exit', settled);
    child.once('error', () => { if ('pid' in child && !child.pid) settled(); });
    // Stderr may include private paths or authentication diagnostics; do not forward it to UI/logs.
    if ('stderr' in child) (child as ReturnType<typeof spawn>).stderr?.resume();
    try {
      if ((!this.deps.spawn || this.deps.guard) && 'pid' in child && typeof child.pid === 'number') this.guard = (this.deps.guard ?? guardProcess)(child.pid, () => { child.kill('SIGKILL'); }, childInputFd(child));
    } catch (cause) {
      // Query construction has not returned yet, so query.close() is unavailable.
      // Keep exit observation installed and terminate this actual child directly.
      child.kill('SIGKILL'); throw cause;
    }
    if (child.exitCode !== null || child.signalCode) settled();
    return child;
  };
  private initialize(): void {
    const options: Options = {
      cwd: this.options.cwd, pathToClaudeCodeExecutable: this.options.executablePath ?? 'claude', env: this.options.env,
      ...(this.contextId ? { resume: this.contextId } : {}),
      includePartialMessages: true, permissionMode: 'default', settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      abortController: this.abort, canUseTool: this.canUseTool,
      spawnClaudeCodeProcess: this.spawnProcess,
      onElicitation: async (request, context) => {
        await this.unsupported('MCP elicitation', plain(request.message), context.signal);
        return { action: 'decline' };
      },
      onUserDialog: async (request, context) => {
        await this.unsupported('不支持的 Claude 对话框', plain(request.dialogKind), context.signal);
        return { behavior: 'cancelled' };
      },
    };
    this.query = (this.deps.query ?? cliQuery)({ prompt: this.prompts, options });
    this.reading = this.read();
  }
  async startTurn(input: { runId: string; text: string }): Promise<void> {
    if (this.closed || this.failed) throw error('ENGINE_EXITED', 'Claude 已关闭，请明确创建新的运行实例');
    if (this.turn) throw error('SESSION_BUSY', 'Claude 当前回合尚未结束');
    if (!input.runId || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 65_536) throw error('INVALID_PROMPT', 'Claude 输入为空或超过 64 KiB');
    const turn: Turn = { id: input.runId, uuid: randomUUID(), done: deferred() };
    this.turn = turn;
    this.tools.clear();
    try {
      if (!this.query) this.initialize();
      if (this.guard) await this.guard.ready;
      if (this.closed || this.failed || this.turn !== turn) return;
      turn.queued = true;
      this.prompts.push({ type: 'user', uuid: turn.uuid, session_id: this.contextId ?? undefined, parent_tool_use_id: null, message: { role: 'user', content: input.text } });
    } catch (cause) {
      this.failed = true; this.query?.close(); this.abort.abort(); this.prompts.end();
      if (this.process && this.processEnded) {
        this.process.kill('SIGKILL');
        await bounded(this.processEnded.promise, this.deps.timeoutMs ?? 5000, '无法确认 Claude 启动失败后的进程退出');
      }
      this.finish('failed', plain((cause as Error).message)); throw cause;
    }
  }
  private async read(): Promise<void> {
    let cause = 'Claude 进程输出流意外结束';
    try { for await (const message of this.query!) this.receive(message); }
    catch (caught) { cause = plain((caught as Error).message); }
    finally {
      this.prompts.end();
      if (!this.closed) {
        this.failed = true;
        this.query?.close(); this.abort.abort();
        const runId = this.turn?.id ?? null;
        this.finish('failed', cause);
        if (!this.emittedExit) { this.emittedExit = true; this.emit({ type: 'process.exited', runId, error: cause }); }
      }
    }
  }
  private receive(message: SDKMessage): void {
    const turn = this.turn;
    if (!turn) return;
    if ('session_id' in message && message.session_id) {
      if (this.contextId && this.contextId !== message.session_id) throw error('CONTEXT_MISMATCH', 'Claude 返回了不同的会话 ID，已停止以避免串会话');
      if (!this.contextId) this.contextId = message.session_id;
      if (message.type === 'system' && message.subtype === 'init') this.emit({ type: 'context', runId: turn.id, nativeContextId: this.contextId });
    }
    switch (message.type) {
      case 'stream_event': {
        if (message.parent_tool_use_id) break;
        const event = message.event;
        if (event.type === 'message_start') turn.streamMessageId = event.message.id;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const messageId = turn.streamMessageId ?? `${turn.id}:assistant`;
          turn.lastMessageId = messageId;
          this.emit({ type: 'message.delta', runId: turn.id, messageId, text: event.delta.text });
        }
        break;
      }
      case 'assistant': {
        if (message.parent_tool_use_id) break;
        const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (text) {
          turn.lastMessageId = message.message.id;
          this.emit({ type: 'message.completed', runId: turn.id, messageId: message.message.id, text });
        }
        for (const block of message.message.content) {
          if (block.type === 'tool_use') this.tool(block.id, block.name, summary(typeof block.input === 'object' && block.input !== null ? block.input as Record<string, unknown> : {}), 'running');
        }
        break;
      }
      case 'user': {
        if (Array.isArray(message.message.content)) for (const block of message.message.content) {
          if (block.type === 'tool_result') {
            const existing = this.tools.get(block.tool_use_id);
            if (existing) this.tool(existing.id, existing.title, block.is_error ? '工具执行失败' : '工具执行完成', block.is_error ? 'failed' : 'completed');
          }
        }
        break;
      }
      case 'tool_progress': this.tool(message.tool_use_id, message.tool_name, `运行 ${Math.max(0, Math.round(message.elapsed_time_seconds))} 秒`, 'running'); break;
      case 'result': {
        if (message.user_message_uuid && message.user_message_uuid !== turn.uuid) throw error('TURN_MISMATCH', 'Claude 返回了不同输入的结果，已停止');
        const interrupted = message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools';
        const failed = message.subtype !== 'success' || message.is_error;
        if (message.subtype === 'success' && message.result && !interrupted && !failed) this.emit({ type: 'message.completed', runId: turn.id, messageId: turn.lastMessageId ?? `${turn.id}:assistant`, text: message.result });
        this.finish(interrupted ? 'interrupted' : failed ? 'failed' : 'completed', failed && !interrupted ? plain(message.subtype === 'success' ? message.result : message.errors.join('\n')) : undefined);
        break;
      }
    }
  }
  private tool(id: string, title: string, detail: string, state: AgentTool['state']): void {
    if (!this.turn) return;
    const tool: AgentTool = { id, runId: this.turn.id, title: plain(title, 160), detail: plain(detail), state };
    this.tools.set(id, tool); this.emit({ type: 'tool', tool });
  }
  private finish(outcome: 'completed' | 'interrupted' | 'failed', errorMessage?: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.clearPending('回合已结束');
    for (const tool of this.tools.values()) if (tool.state === 'running') this.tool(tool.id, tool.title, outcome === 'completed' ? '工具执行完成' : '工具已停止', outcome === 'completed' ? 'completed' : 'failed');
    turn.outcome = outcome; this.turn = undefined;
    this.emit({ type: 'turn.completed', runId: turn.id, outcome, ...(errorMessage ? { error: errorMessage } : {}) });
    turn.done.resolve();
  }
  private question(input: Record<string, unknown>, id: string): AgentQuestion[] | undefined {
    if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return;
    const result: AgentQuestion[] = [];
    for (const [index, raw] of input.questions.entries()) {
      if (!raw || typeof raw !== 'object') return;
      const q = raw as Record<string, unknown>;
      if (typeof q.question !== 'string' || typeof q.header !== 'string' || !Array.isArray(q.options) || q.options.length > 8) return;
      const options: AgentQuestion['options'] = [];
      for (const rawOption of q.options) {
        if (!rawOption || typeof rawOption !== 'object' || typeof rawOption.label !== 'string') return;
        options.push({ label: plain(rawOption.label, 200), ...(typeof rawOption.description === 'string' ? { description: plain(rawOption.description, 500) } : {}) });
      }
      result.push({ id: `${id}:${index}`, header: plain(q.header, 200), question: plain(q.question, 2000), options, multiple: q.multiSelect === true });
    }
    return result;
  }
  private canUseTool: CanUseTool = async (name, input, context) => {
    if (!this.turn || this.closed || context.signal.aborted) return { behavior: 'deny', message: '回合已结束', interrupt: true };
    const id = randomUUID();
    const questions = name === 'AskUserQuestion' ? this.question(input, id) : undefined;
    const unsupported = name === 'ExitPlanMode' || name === 'EnterPlanMode' || (name === 'AskUserQuestion' && !questions);
    const interaction: AgentInteraction = {
      id, runId: this.turn.id, kind: unsupported ? 'unsupported' : questions ? 'question' : 'permission',
      title: plain(name, 160), detail: unsupported ? '此交互尚未支持；可以拒绝或中断回合。' : questions ? 'Claude 需要你的回答' : summary(input),
      ...(questions ? { questions } : {}), actions: unsupported ? ['deny', 'cancel-turn'] : questions ? ['submit', 'deny', 'cancel-turn'] : ['allow-once', 'deny', 'cancel-turn'],
    };
    return this.waitInteraction(interaction, input, context.signal);
  };
  private waitInteraction(interaction: AgentInteraction, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    return new Promise(resolve => {
      const abort = () => this.resolvePending(interaction.id, { behavior: 'deny', message: '交互已取消', interrupt: true });
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(interaction.id, { interaction, input, resolve, cleanup: () => signal.removeEventListener('abort', abort) });
      this.emit({ type: 'interaction', interaction });
      if (signal.aborted) abort();
    });
  }
  private async unsupported(title: string, detail: string, signal: AbortSignal): Promise<void> {
    if (!this.turn || this.closed || signal.aborted) return;
    await this.waitInteraction({ id: randomUUID(), runId: this.turn.id, kind: 'unsupported', title, detail, actions: ['deny', 'cancel-turn'] }, {}, signal);
  }
  private resolvePending(id: string, result: PermissionResult): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); pending.cleanup(); pending.resolve(result);
    this.emit({ type: 'interaction.resolved', runId: pending.interaction.runId, interactionId: id });
  }
  private clearPending(message: string): void { for (const id of [...this.pending.keys()]) this.resolvePending(id, { behavior: 'deny', message, interrupt: true }); }
  async respond(id: string, answer: AgentAnswer): Promise<void> {
    const pending = this.pending.get(id);
    if (!pending || pending.interaction.runId !== this.turn?.id) throw error('INTERACTION_EXPIRED', 'Claude 交互已失效');
    if (!pending.interaction.actions.includes(answer.action)) throw error('INVALID_ANSWER', '不支持此回答动作');
    if (answer.action === 'cancel-turn') { await this.interrupt(pending.interaction.runId); return; }
    if (answer.action === 'deny') { this.resolvePending(id, { behavior: 'deny', message: '用户拒绝了此请求' }); return; }
    if (answer.action === 'allow-once') { this.resolvePending(id, { behavior: 'allow', updatedInput: pending.input }); return; }
    const questions = pending.interaction.questions!;
    if (!answer.answers || Object.keys(answer.answers).length !== questions.length) throw error('INVALID_ANSWER', '请回答所有问题');
    const answers: Record<string, string> = Object.create(null) as Record<string, string>;
    const originals = pending.input.questions as Array<{ question: string }>;
    for (const [index, question] of questions.entries()) {
      const values = answer.answers[question.id];
      if (!Array.isArray(values) || !values.length || values.length > 16 || (!question.multiple && values.length !== 1) || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 4000)) throw error('INVALID_ANSWER', '问题回答无效');
      answers[originals[index].question] = values.join(', ');
    }
    this.resolvePending(id, { behavior: 'allow', updatedInput: { ...pending.input, answers } });
  }
  async interrupt(runId: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.id !== runId || !this.query) throw error('RUN_MISMATCH', 'Claude 回合已变化');
    if (!turn.queued || this.prompts.remove(turn.uuid)) { this.finish('interrupted'); return; }
    this.clearPending('用户请求中断');
    try {
      await bounded(this.query.interrupt(), this.deps.timeoutMs ?? 10_000, 'Claude 尚未确认中断请求');
      await bounded(turn.done.promise, this.deps.timeoutMs ?? 10_000, 'Claude 尚未发出回合结束确认');
      if (turn.outcome === 'failed') throw error('INTERRUPT_UNCONFIRMED', 'Claude 进程失败，未确认正常中断');
    } catch (cause) {
      // An unacknowledged early interrupt must never leave the original prompt running later.
      await this.close();
      if (turn.outcome === 'failed') throw cause;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.closeInternal(); this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }
  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.clearPending('运行实例已关闭'); this.prompts.end();
    this.query?.close(); this.abort.abort();
    if (this.process && this.processEnded) {
      try { await bounded(this.processEnded.promise, this.deps.timeoutMs ?? 5000, 'Claude 进程尚未退出'); }
      catch {
        this.process.kill('SIGKILL');
        await bounded(this.processEnded.promise, this.deps.timeoutMs ?? 5000, '无法确认 Claude 进程退出');
      }
    }
    if (this.reading) await bounded(this.reading, this.deps.timeoutMs ?? 5000, 'Claude SDK 输出流尚未关闭');
    this.finish('interrupted');
  }
}
