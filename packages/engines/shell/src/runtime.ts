import { guardProcess, type ProcessGuard } from '../../shared/src/process-guard.ts';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { TerminalOutput, TerminalSnapshot } from '../../../protocol/src/index.ts';

const { Terminal } = headless;

const HIGH_WATER_BYTES = 256 * 1024;
const LOW_WATER_BYTES = 64 * 1024;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUE_FRAMES = 8192;
const MAX_INPUT_IDS = 4096;
const MAX_BARRIERS = 128;
const TERMINATE_GRACE_MS = 1500;

export interface ShellRuntimeOptions {
  sessionId: string;
  runId: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  onOutput: (frame: TerminalOutput) => void;
  onExit: (result: { exitCode: number; signal?: number }) => void;
  onError?: (error: Error) => void;
}

type Input = { runId: string; terminalEpoch: string; inputId: string; data: string };

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < 2 || cols > 500 ||
      !Number.isInteger(rows) || rows < 2 || rows > 200) {
    throw new RangeError('终端尺寸必须为 2..500 列、2..200 行');
  }
}

/** One PTY incarnation. No input or output is persisted or replayed. */
export class ShellRuntime {
  readonly sessionId: string;
  readonly runId: string;
  readonly terminalEpoch = randomUUID();
  readonly #options: ShellRuntimeOptions;
  readonly #terminal: HeadlessTerminal;
  readonly #serializer: SerializeAddon;
  readonly #pty: pty.IPty;
  readonly #guard: ProcessGuard;
  readonly #subscriptions: pty.IDisposable[] = [];
  readonly #inputIds = new Set<string>();
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #queue = Promise.resolve();
  #queuedBytes = 0;
  #queuedFrames = 0;
  #barriers = 0;
  #paused = false;
  #exited = false;
  #failed = false;
  #terminating = false;
  #disposed = false;
  #outputSeq = 0;
  #finalSnapshot?: TerminalSnapshot;
  #killTimer?: ReturnType<typeof setTimeout>;

  constructor(options: ShellRuntimeOptions) {
    validateSize(options.cols, options.rows);
    if (!options.sessionId || !options.runId || !options.cwd || !options.shell) {
      throw new TypeError('Shell 运行身份、目录和可执行文件不能为空');
    }
    this.#options = options;
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#terminal = new Terminal({
      cols: options.cols, rows: options.rows, scrollback: 5000,
      allowProposedApi: true,
    });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
    try {
      this.#pty = pty.spawn(options.shell, ['-il'], {
        name: 'xterm-256color', cwd: options.cwd,
        cols: options.cols, rows: options.rows,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
    } catch (error) {
      this.#terminal.dispose();
      this.#report(error);
      throw error;
    }
    // Pinned node-pty 1.1.0 exposes its native master internally. Hold an
    // inherited duplicate in the guard so Host SIGKILL cannot drop PTY ownership
    // before the guard verifies and terminates the shell's own descendants.
    const fd = (this.#pty as pty.IPty & { _fd?: number })._fd;
    try {
      if (!Number.isInteger(fd) || fd! < 0) throw new Error('不兼容的 PTY：无法建立进程监护');
      this.#guard = guardProcess(this.#pty.pid, error => { this.#report(error); void this.terminate(); }, fd);
    } catch (error) { this.#pty.kill('SIGKILL'); this.#terminal.dispose(); throw error; }
    this.#subscriptions.push(this.#pty.onData((data) => this.#receive(data)));
    this.#subscriptions.push(this.#pty.onExit((result) => this.#didExit(result)));
  }

  ready(): Promise<void> { return this.#guard.ready; }
  get exited(): boolean { return this.#exited; }
  get cols(): number { return this.#terminal.cols; }
  get rows(): number { return this.#terminal.rows; }
  get parsedOutputSeq(): number { return this.#outputSeq; }

  input(input: Input): void {
    if (input.runId !== this.runId || input.terminalEpoch !== this.terminalEpoch) {
      throw new Error('终端输入属于过期的运行实例');
    }
    if (typeof input.inputId !== 'string' || !input.inputId || input.inputId.length > 128 ||
        typeof input.data !== 'string' || Buffer.byteLength(input.data, 'utf8') > 16 * 1024) {
      throw new RangeError('终端输入无效或超过 16 KiB');
    }
    this.#assertRunning();
    if (this.#inputIds.has(input.inputId)) return;
    // The transport must never resend uncertain input. This bounded window only
    // catches recent duplicate delivery; IDs are not durable command receipts.
    this.#inputIds.add(input.inputId);
    if (this.#inputIds.size > MAX_INPUT_IDS) {
      this.#inputIds.delete(this.#inputIds.values().next().value!);
    }
    try { this.#pty.write(input.data); }
    catch (error) { this.#report(error); throw error; }
  }

  resize(cols: number, rows: number): Promise<TerminalSnapshot> {
    validateSize(cols, rows);
    this.#assertRunning();
    return this.#barrier(() => {
      this.#assertRunning();
      this.#pty.resize(cols, rows);
      this.#terminal.resize(cols, rows);
      return this.#serialize();
    });
  }

  snapshot(): Promise<TerminalSnapshot> {
    return this.#barrier(() => this.#finalSnapshot ?? this.#serialize());
  }

  terminate(): Promise<void> {
    if (!this.#exited && !this.#terminating) {
      this.#terminating = true;
      this.#signal('SIGHUP');
      // A synchronous exit callback may already have settled the promise.
      if (!this.#exited) {
        this.#killTimer = setTimeout(() => {
          this.#killTimer = undefined;
          if (!this.#exited) this.#signal('SIGKILL');
        }, TERMINATE_GRACE_MS);
      }
    }
    return this.#exitPromise;
  }

  #assertRunning(): void {
    if (this.#exited || this.#terminating || this.#failed) throw new Error('Shell 已退出或正在结束');
  }

  #report(error: unknown): void {
    try { this.#options.onError?.(error instanceof Error ? error : new Error(String(error))); }
    catch { /* Error observers cannot break process cleanup. */ }
  }

  #signal(signal: string): void {
    try { this.#pty.kill(signal); }
    catch (error) { this.#report(error); }
  }

  #receive(data: string): void {
    if (this.#exited || this.#failed) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.#queuedBytes + bytes > MAX_QUEUE_BYTES || this.#queuedFrames >= MAX_QUEUE_FRAMES) {
      this.#failed = true;
      this.#report(new Error('终端解析队列超过上限，正在结束运行实例'));
      void this.terminate();
      return;
    }
    this.#queuedBytes += bytes;
    this.#queuedFrames++;
    if (!this.#paused && (this.#queuedBytes >= HIGH_WATER_BYTES || this.#queuedFrames >= 2048)) {
      this.#paused = true;
      try { this.#pty.pause(); } catch (error) { this.#report(error); }
    }
    this.#enqueue(async () => {
      try {
        await new Promise<void>((resolve) => this.#terminal.write(data, resolve));
        const frame: TerminalOutput = {
          protocolVersion: 1, type: 'terminal.output', sessionId: this.sessionId,
          runId: this.runId, terminalEpoch: this.terminalEpoch,
          outputSeq: ++this.#outputSeq, data,
        };
        try { this.#options.onOutput(frame); } catch (error) { this.#report(error); }
      } finally {
        this.#queuedBytes -= bytes;
        this.#queuedFrames--;
        if (this.#paused && this.#queuedBytes <= LOW_WATER_BYTES && this.#queuedFrames <= 512) {
          this.#paused = false;
          if (!this.#exited) {
            try { this.#pty.resume(); } catch (error) { this.#report(error); }
          }
        }
      }
    });
  }

  #enqueue(operation: () => void | Promise<void>): void {
    this.#queue = this.#queue.then(operation).catch((error) => { this.#report(error); });
  }

  #barrier(operation: () => TerminalSnapshot): Promise<TerminalSnapshot> {
    if (this.#barriers >= MAX_BARRIERS) return Promise.reject(new Error('终端快照请求过多'));
    this.#barriers++;
    return new Promise((resolve, reject) => {
      this.#enqueue(() => {
        try { resolve(operation()); }
        catch (error) { this.#report(error); reject(error); }
        finally { this.#barriers--; }
      });
    });
  }

  #serialize(): TerminalSnapshot {
    return {
      sessionId: this.sessionId, runId: this.runId, terminalEpoch: this.terminalEpoch,
      cols: this.#terminal.cols, rows: this.#terminal.rows,
      parsedOutputSeq: this.#outputSeq,
      serializedState: this.#serializer.serialize({ scrollback: 5000 }),
    };
  }

  #didExit(result: { exitCode: number; signal?: number }): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#guard.dispose();
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#killTimer = undefined;
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#subscriptions.length = 0;
    this.#enqueue(() => {
      try { this.#finalSnapshot = this.#serialize(); }
      finally {
        if (!this.#disposed) { this.#disposed = true; this.#terminal.dispose(); }
        this.#inputIds.clear();
        try { this.#options.onExit(result); } catch (error) { this.#report(error); }
        this.#resolveExit();
      }
    });
  }
}
