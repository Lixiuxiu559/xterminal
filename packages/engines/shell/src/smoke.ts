import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { TerminalOutput } from '../../../protocol/src/index.ts';
import { ShellRuntime } from './runtime.ts';

const { Terminal } = headless;

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const markerCommand = (marker: string): string => {
  const half = Math.floor(marker.length / 2);
  return `printf '%s%s\\n' ${quote(marker.slice(0, half))} ${quote(marker.slice(half))}`;
};

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function visibleText(terminal: HeadlessTerminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true));
}

/** Runs in Node with the matching PTY ABI, or inside Electron's utility process. */
export async function runShellRuntimeSmoke(): Promise<{ assertions: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'xterminal-shell-'));
  const frames: TerminalOutput[] = [];
  const errors: Error[] = [];
  let exitCount = 0;
  let runtime: ShellRuntime | undefined;
  const assertions: string[] = [];
  try {
    const childDirectory = join(directory, '中文目录');
    await mkdir(childDirectory);
    runtime = new ShellRuntime({
      sessionId: randomUUID(), runId: randomUUID(), cwd: directory,
      shell: '/bin/bash', cols: 80, rows: 24,
      onOutput: (frame) => { frames.push(frame); },
      onExit: () => { exitCount++; }, onError: (error) => { errors.push(error); },
    });
    const shell = runtime;
    const send = (data: string, inputId = randomUUID()): void => {
      shell.input({ runId: shell.runId, terminalEpoch: shell.terminalEpoch, inputId, data });
    };
    const has = (value: string): boolean => frames.map((frame) => frame.data).join('').includes(value);
    const ready = `ready_${randomUUID()}`;
    send(`stty -echo; ${markerCommand(ready)}\r`);
    await until(() => has(ready), '交互 Shell 就绪');

    const cwdMarker = `cwd_${randomUUID()}`;
    send(`cd ${quote(childDirectory)}\r`);
    send(`pwd; ${markerCommand(cwdMarker)}\r`);
    await until(() => has(cwdMarker), '持久 cwd');
    assert.ok(has(childDirectory));
    assertions.push('D04：同一 PTY 保持 cd 后的 cwd，中文输出正确');

    const dedupMarker = `once_${randomUUID()}`;
    const duplicateId = randomUUID();
    const dedupCommand = `${markerCommand(dedupMarker)}\r`;
    send(dedupCommand, duplicateId);
    send(dedupCommand, duplicateId);
    await until(() => has(dedupMarker), '去重输出');
    assert.throws(() => shell.input({ runId: 'stale', terminalEpoch: shell.terminalEpoch, inputId: 'a', data: 'x' }));
    assert.throws(() => shell.input({ runId: shell.runId, terminalEpoch: 'stale', inputId: 'a', data: 'x' }));
    assert.throws(() => send('中'.repeat(6000)));
    assert.throws(() => shell.resize(1, 24));
    assert.throws(() => shell.resize(80, 201));

    const tick = `tick_${randomUUID()}`;
    send(`while :; do ${markerCommand(tick)}; sleep 0.03; done\r`);
    await until(() => has(tick), '持续输出');
    const snapshot = await shell.snapshot();
    assert.ok(snapshot.serializedState.includes(tick));
    await new Promise((resolve) => setTimeout(resolve, 100));
    send('\x03');
    const interrupted = `interrupt_${randomUUID()}`;
    send(`${markerCommand(interrupted)}\r`);
    await until(() => has(interrupted), 'Ctrl+C 后 Shell 仍可输入');
    assert.equal(shell.exited, false);
    assertions.push('D05：Ctrl+C 中断前台循环，Shell 继续运行');

    const final = await shell.snapshot();
    const restored = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true, scrollback: 5000 });
    const expected = new Terminal({ cols: final.cols, rows: final.rows, allowProposedApi: true, scrollback: 5000 });
    try {
      const write = (terminal: HeadlessTerminal, data: string): Promise<void> => new Promise((resolve) => terminal.write(data, resolve));
      await write(restored, snapshot.serializedState);
      for (const frame of frames.filter((frame) => frame.outputSeq > snapshot.parsedOutputSeq && frame.outputSeq <= final.parsedOutputSeq)) {
        await write(restored, frame.data);
      }
      await write(expected, final.serializedState);
      assert.deepEqual(visibleText(restored), visibleText(expected));
      assert.equal(restored.buffer.active.cursorX, expected.buffer.active.cursorX);
      assert.equal(restored.buffer.active.cursorY, expected.buffer.active.cursorY);
    } finally { restored.dispose(); expected.dispose(); }
    assert.equal(frames.map((frame) => frame.data).join('').split(dedupMarker).length - 1, 1);
    assert.deepEqual(frames.map((frame) => frame.outputSeq), frames.map((_, i) => i + 1));
    assertions.push('D06：持续输出时快照 + watermark 后续帧恢复文本与光标一致，序号连续');

    const resized = await shell.resize(100, 32);
    assert.equal(resized.cols, 100);
    assert.equal(resized.rows, 32);
    assert.equal(resized.terminalEpoch, snapshot.terminalEpoch);
    assertions.push('D07：旧 run/epoch、超长 UTF-8、非法尺寸被拒绝，重复 inputId 仅执行一次，resize 不换 epoch');

    const burstDone = `burst_${randomUUID()}`;
    send(`i=0; while [ "$i" -lt 6000 ]; do printf '%080d\\n' "$i"; i=$((i+1)); done; ${markerCommand(burstDone)}\r`);
    await until(() => has(burstDone), '突发输出与解析队列排空');
    const burstSnapshot = await shell.snapshot();
    const bounded = new Terminal({ cols: 100, rows: 32, allowProposedApi: true, scrollback: 5000 });
    try {
      await new Promise<void>((resolve) => bounded.write(burstSnapshot.serializedState, resolve));
      assert.ok(bounded.buffer.active.length > 5000);
      assert.ok(bounded.buffer.active.length <= 5032);
      assert.ok(burstSnapshot.serializedState.includes(burstDone));
    } finally { bounded.dispose(); }
    assertions.push('突发输出：约 480 KiB 输出完成且 scrollback 限制为 5000 行');

    // Ignore SIGHUP so terminate must wait for its SIGKILL fallback and real exit.
    const trapped = `trap_${randomUUID()}`;
    send(`trap '' HUP; ${markerCommand(trapped)}\r`);
    await until(() => has(trapped), '安装测试退出 trap');
    const stopped = shell.terminate();
    const stoppedAgain = shell.terminate();
    assert.strictEqual(stoppedAgain, stopped);
    await stopped;
    assert.equal(shell.exited, true);
    assert.equal(exitCount, 1);
    assert.throws(() => send('echo should-not-run\r'));
    assert.ok((await shell.snapshot()).parsedOutputSeq >= final.parsedOutputSeq);
    assert.deepEqual(errors, []);
    assertions.push('真实退出：SIGHUP 后 SIGKILL 回收，重复 terminate 共享等待，onExit 仅调用一次');
    return { assertions };
  } finally {
    if (runtime) await runtime.terminate();
    await rm(directory, { recursive: true, force: true });
  }
}
