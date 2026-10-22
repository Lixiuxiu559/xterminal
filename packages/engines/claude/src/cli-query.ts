import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Options, Query, SDKMessage, SDKUserMessage, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeQuery = AsyncIterable<SDKMessage> & Pick<Query, 'interrupt' | 'close'>;
interface QueryInput { prompt: AsyncIterable<SDKUserMessage>; options: Options }
interface Limits { maxLineBytes?: number; maxQueueBytes?: number; controlTimeoutMs?: number; terminateGraceMs?: number }
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude 控制协议对象无效');
  return value as ObjectValue;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw new Error(`Claude 控制协议 ${name} 无效`);
  return value;
}
class Output implements AsyncIterable<SDKMessage> {
  private values: Array<{ value: SDKMessage; bytes: number }> = [];
  private bytes = 0;
  private ended = false;
  private error?: Error;
  private wake?: () => void;
  private readonly maximum: number;
  private readonly flow: (paused: boolean) => void;
  constructor(maximum: number, flow: (paused: boolean) => void) { this.maximum = maximum; this.flow = flow; }
  push(value: SDKMessage, bytes: number): void {
    if (this.ended) return;
    if (this.bytes + bytes > this.maximum || this.values.length >= 4096) throw new Error('Claude 输出队列超过上限');
    this.values.push({ value, bytes }); this.bytes += bytes;
    if (this.bytes >= this.maximum / 2) this.flow(true);
    this.wake?.();
  }
  end(error?: Error): void { this.ended = true; this.error = error; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    while (true) {
      const entry = this.values.shift();
      if (entry) {
        this.bytes -= entry.bytes;
        if (this.bytes < this.maximum / 4) this.flow(false);
        yield entry.value; continue;
      }
      if (this.ended) { if (this.error) throw this.error; return; }
      await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
    }
  }
}

/**
 * Local, unmodified Claude Code 2.1.304 only. Control frame shapes and the hidden
 * --permission-prompt-tool=stdio flag mirror published SDK 0.3.304 sources.
 * This stdio control protocol is version-locked, not a stable public API promise.
 * No SDK runtime, SDK entrypoint environment, credential extraction or provider override.
 */
export function cliQuery(input: QueryInput, limits: Limits = {}): ClaudeQuery {
  return new CliQuery(input, limits);
}
class CliQuery implements ClaudeQuery {
  private readonly child: SpawnedProcess;
  private readonly output: Output;
  private readonly decoder = new StringDecoder('utf8');
  private readonly spawningAbort = new AbortController();
  private readonly controls = new Map<string, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly requests = new Map<string, AbortController>();
  private readonly initialize: Promise<ObjectValue>;
  private writing = Promise.resolve();
  private waitingWriteBytes = 0;
  private buffer = '';
  private closing = false;
  private exited = false;
  private stdoutEnded = false;
  private terminalError?: Error;
  private killTimer?: ReturnType<typeof setTimeout>;
  private readonly maximumLine: number;
  private readonly externalAbort: () => void;
  private readonly input: QueryInput;
  private readonly limits: Limits;
  constructor(input: QueryInput, limits: Limits) {
    this.input = input; this.limits = limits;
    this.maximumLine = limits.maxLineBytes ?? 1024 * 1024;
    this.output = new Output(limits.maxQueueBytes ?? 4 * 1024 * 1024, paused => { if (paused) this.child.stdout.pause(); else if (!this.exited) this.child.stdout.resume(); });
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompts', 'host', '--permission-prompt-tool=stdio', '--permission-mode', 'manual'];
    if (input.options.resume) args.push('--resume', input.options.resume);
    // Preserve native CLI defaults: no custom/minimal system prompt or setting-source filtering.
    const spawnOptions: SpawnOptions = { command: input.options.pathToClaudeCodeExecutable ?? 'claude', args, cwd: input.options.cwd, env: process.env, signal: this.spawningAbort.signal };
    this.child = input.options.spawnClaudeCodeProcess ? input.options.spawnClaudeCodeProcess(spawnOptions) : spawn(spawnOptions.command, args, { cwd: spawnOptions.cwd, stdio: ['pipe', 'pipe', 'pipe'], signal: spawnOptions.signal, windowsHide: true });
    if ('stderr' in this.child) (this.child as ReturnType<typeof spawn>).stderr?.resume();
    this.child.stdout.on('data', this.onData);
    this.child.stdout.once('end', this.onEnd);
    this.child.stdout.once('error', this.fail);
    this.child.stdin.on('error', this.fail);
    this.child.once('error', this.fail);
    this.child.once('exit', (code, signal) => {
      this.exited = true; this.clearControls(new Error('Claude 进程已退出'));
      if (this.killTimer) clearTimeout(this.killTimer);
      input.options.abortController?.signal.removeEventListener('abort', this.externalAbort);
      for (const controller of this.requests.values()) controller.abort();
      this.requests.clear();
      if (!this.closing && (code !== 0 || signal)) this.terminalError ??= new Error('Claude 进程异常退出');
      // Node's exit event can precede the last stdout data/end events. Drain the tail first.
      if (this.stdoutEnded) this.output.end(this.terminalError);
    });
    this.externalAbort = () => this.close();
    input.options.abortController?.signal.addEventListener('abort', this.externalAbort, { once: true });
    this.initialize = this.control({ subtype: 'initialize' });
    void this.pumpPrompts().catch(this.fail);
    if (input.options.abortController?.signal.aborted) this.close();
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> { return this.output[Symbol.asyncIterator](); }
  private fail = (cause: unknown): void => {
    if (this.closing) return;
    this.terminalError = cause instanceof Error ? cause : new Error('Claude 传输失败');
    this.output.end(this.terminalError); this.close();
  };
  private onData = (chunk: Buffer | string): void => {
    if (this.closing) return;
    try {
      this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > this.maximumLine) throw new Error('Claude JSONL 帧超过上限');
        if (line.trim()) this.frame(object(JSON.parse(line)), Buffer.byteLength(line));
      }
      if (Buffer.byteLength(this.buffer) > this.maximumLine) throw new Error('Claude JSONL 分片超过上限');
    } catch (cause) { this.fail(cause); }
  };
  private onEnd = (): void => {
    this.stdoutEnded = true;
    if (this.closing) return;
    this.buffer += this.decoder.end();
    if (this.buffer.trim()) this.fail(new Error('Claude 输出包含未结束的 JSONL 帧'));
    else this.output.end(this.terminalError);
  };
  private frame(frame: ObjectValue, bytes: number): void {
    switch (frame.type) {
      case 'control_response': {
        const response = object(frame.response); const id = text(response.request_id, 'request_id');
        const pending = this.controls.get(id);
        if (!pending) return;
        this.controls.delete(id); clearTimeout(pending.timer);
        if (response.subtype === 'success') pending.resolve(response.response === undefined ? {} : object(response.response));
        else pending.reject(new Error('Claude 拒绝了控制请求'));
        return;
      }
      case 'control_request': void this.answerRequest(frame).catch(this.fail); return;
      case 'control_cancel_request': this.requests.get(text(frame.request_id, 'request_id'))?.abort(); return;
      case 'keep_alive': return;
      default:
        if (typeof frame.type !== 'string') throw new Error('Claude 输出缺少消息类型');
        this.output.push(frame as unknown as SDKMessage, bytes);
    }
  }
  private async answerRequest(frame: ObjectValue): Promise<void> {
    const id = text(frame.request_id, 'request_id');
    if (this.requests.has(id)) return;
    if (this.requests.size >= 64) throw new Error('Claude 挂起的交互请求超过上限');
    const request = object(frame.request); const subtype = text(request.subtype, 'subtype');
    const controller = new AbortController(); this.requests.set(id, controller);
    let response: unknown;
    try {
      if (subtype === 'can_use_tool' && this.input.options.canUseTool) {
        const toolUseID = text(request.tool_use_id, 'tool_use_id');
        response = await this.input.options.canUseTool(text(request.tool_name, 'tool_name'), object(request.input), {
          signal: controller.signal, toolUseID, requestId: id,
          ...(typeof request.blocked_path === 'string' ? { blockedPath: request.blocked_path } : {}),
          ...(typeof request.decision_reason === 'string' ? { decisionReason: request.decision_reason } : {}),
          ...(typeof request.title === 'string' ? { title: request.title } : {}),
        });
        // Never return persistent rules to the CLI: approvals are one action only.
        const permission = object(response);
        if (permission.behavior === 'allow') response = { behavior: 'allow', updatedInput: permission.updatedInput ?? request.input, toolUseID };
        else response = { behavior: 'deny', message: typeof permission.message === 'string' ? permission.message : '请求已拒绝', interrupt: permission.interrupt === true, toolUseID };
      } else if (subtype === 'elicitation' && this.input.options.onElicitation) {
        response = await this.input.options.onElicitation({ serverName: text(request.mcp_server_name, 'mcp_server_name'), message: typeof request.message === 'string' ? request.message : '', mode: request.mode === 'url' ? 'url' : 'form', ...(typeof request.url === 'string' ? { url: request.url } : {}), ...(typeof request.elicitation_id === 'string' ? { elicitationId: request.elicitation_id } : {}), ...(request.requested_schema ? { requestedSchema: object(request.requested_schema) as never } : {}) }, { signal: controller.signal, requestId: id });
      } else if (subtype === 'request_user_dialog' && this.input.options.onUserDialog) {
        response = await this.input.options.onUserDialog({ dialogKind: text(request.dialog_kind, 'dialog_kind'), payload: object(request.payload), ...(typeof request.tool_use_id === 'string' ? { toolUseID: request.tool_use_id } : {}) }, { signal: controller.signal, requestId: id });
      } else {
        // Includes OAuth/host-token refresh: authentication remains entirely inside the official CLI.
        await this.write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'XTerminal 不支持此控制请求，已安全停止' } });
        throw new Error('Claude 请求了不支持的控制交互');
      }
      if (controller.signal.aborted || this.closing) return;
      await this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: response ?? { behavior: 'deny', message: '交互未得到明确回答' } } });
    } finally { this.requests.delete(id); }
  }
  private async pumpPrompts(): Promise<void> {
    await this.initialize;
    for await (const prompt of this.input.prompt) {
      if (this.closing) return;
      await this.write(prompt);
    }
    if (!this.closing) this.child.stdin.end();
  }
  private write(value: unknown): Promise<void> {
    const line = JSON.stringify(value) + '\n'; const bytes = Buffer.byteLength(line);
    if (bytes > this.maximumLine || this.waitingWriteBytes + bytes > 1024 * 1024) return Promise.reject(new Error('Claude 输入或待写队列超过上限'));
    this.waitingWriteBytes += bytes;
    const write = this.writing.then(() => {
      if (this.closing || this.exited) throw new Error('Claude 输入流已关闭');
      return new Promise<void>((resolve, reject) => {
        let callbackDone = false, drained = false, submitted = false;
        const finish = () => { if (submitted && callbackDone && drained) { cleanup(); resolve(); } };
        const onDrain = () => { drained = true; finish(); };
        const onError = (cause: Error) => { cleanup(); reject(cause); };
        const cleanup = () => { this.child.stdin.off('drain', onDrain); this.child.stdin.off('error', onError); };
        this.child.stdin.once('drain', onDrain); this.child.stdin.once('error', onError);
        drained = this.child.stdin.write(line, cause => { if (cause) { onError(cause); return; } callbackDone = true; finish(); });
        submitted = true; finish();
      });
    });
    this.writing = write.catch(() => {});
    return write.finally(() => { this.waitingWriteBytes -= bytes; });
  }
  private control(request: ObjectValue): Promise<ObjectValue> {
    const id = randomUUID();
    if (this.controls.size >= 64) return Promise.reject(new Error('Claude 控制请求过多'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controls.delete(id); reject(new Error('Claude 控制请求未确认')); }, this.limits.controlTimeoutMs ?? 10_000);
      this.controls.set(id, { resolve, reject, timer });
      void this.write({ type: 'control_request', request_id: id, request }).catch(cause => { const pending = this.controls.get(id); if (pending) { clearTimeout(pending.timer); this.controls.delete(id); pending.reject(cause); } });
    });
  }
  async interrupt(): ReturnType<Query['interrupt']> {
    await this.initialize;
    const result = await this.control({ subtype: 'interrupt' });
    return Array.isArray(result.still_queued) ? { still_queued: result.still_queued.filter((value): value is string => typeof value === 'string') } : undefined;
  }
  private clearControls(error: Error): void {
    for (const pending of this.controls.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.controls.clear();
  }
  close(): void {
    if (this.closing) return;
    this.closing = true; this.clearControls(new Error('Claude 传输已关闭'));
    for (const request of this.requests.values()) request.abort();
    this.requests.clear(); this.output.end(this.terminalError);
    this.child.stdout.resume(); this.child.stdin.end();
    if (!this.exited) {
      this.killTimer = setTimeout(() => { if (!this.exited) this.child.kill('SIGTERM'); }, this.limits.terminateGraceMs ?? 1500);
      this.killTimer.unref();
    }
  }
}
