import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { AppSession, DesktopBridge } from '../../../packages/protocol/src/desktop';
import type { TerminalOutput, TerminalSnapshot } from '../../../packages/protocol/src/index';
import { Icon } from './icons';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
import { stateNames } from './sessionState';

export function TerminalPane({ bridge, session, online, canControl, onChange }: { bridge: DesktopBridge; session: AppSession; online: boolean; canControl: boolean; onChange: (session: AppSession) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const live = useRef({ session, online, canControl, onChange });
  live.current = { session, online, canControl, onChange };
  const actions = useRef<{ start: () => void; interrupt: () => void; terminate: () => void; focus: () => void; refresh: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [hasOutput, setHasOutput] = useState(false);

  useEffect(() => {
    let disposed = false;
    let syncing = false;
    let rerun = false;
    let resizeWanted = false;
    let sequence = 0;
    let identity: TerminalSnapshot | null = null;
    let pending: TerminalOutput[] = [];
    let pendingBytes = 0;
    let overflowed = false;
    const encoder = new TextEncoder();
    const maxPendingBytes = 1024 * 1024;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const term = new Terminal({
      cursorBlink: true, fontSize: 14, lineHeight: 1.35,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: { background: '#15221c', foreground: '#e1e9df', cursor: '#c4dbb9', selectionBackground: '#55745b80', black: '#15221c', red: '#ef9292', green: '#add29d', yellow: '#e6cb91', blue: '#93b3da', magenta: '#c4a3d9', cyan: '#9acfc6', white: '#e1e9df', brightBlack: '#849c89', brightRed: '#ffa7a7', brightGreen: '#c5e8b6', brightYellow: '#f5dfa9', brightBlue: '#adcbef', brightMagenta: '#ddc0ed', brightCyan: '#b7e5de', brightWhite: '#ffffff' },
      scrollback: 5000, screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    if (live.current.canControl) fit.fit();
    const fail = (err: unknown) => { if (!disposed) setError(errorText(err)); };
    function buffer(frame: TerminalOutput) {
      if (overflowed) return;
      // Include a small per-frame allowance so empty output frames cannot grow the array indefinitely.
      const bytes = encoder.encode(frame.data).byteLength + 128;
      if (pendingBytes + bytes > maxPendingBytes) {
        pending = []; pendingBytes = 0; overflowed = true; rerun = true;
        return;
      }
      pending.push(frame); pendingBytes += bytes;
    }
    function applyFrame(frame: TerminalOutput) {
      if (!identity || frame.runId !== identity.runId || frame.terminalEpoch !== identity.terminalEpoch) return false;
      if (frame.outputSeq <= sequence) return true;
      if (frame.outputSeq !== sequence + 1) return false;
      sequence = frame.outputSeq;
      term.write(frame.data);
      setHasOutput(true);
      return true;
    }
    function install(snapshot: TerminalSnapshot | null) {
      if (disposed) return;
      const buffered = pending;
      pending = []; pendingBytes = 0;
      if (!snapshot) {
        // On process exit, flush any final frames from the previous run and keep its last screen readable.
        for (const frame of buffered.sort((a, b) => a.outputSeq - b.outputSeq)) applyFrame(frame);
        identity = null; sequence = 0;
        setReady(false);
        return;
      }
      identity = snapshot;
      sequence = snapshot.parsedOutputSeq;
      // Queue the reset with parser writes so earlier asynchronous output cannot land after the snapshot.
      term.resize(snapshot.cols, snapshot.rows);
      term.write('\x1bc' + snapshot.serializedState);
      setReady(true); setHasOutput(true);
      const matching = buffered.filter(frame => frame.runId === snapshot.runId && frame.terminalEpoch === snapshot.terminalEpoch).sort((a, b) => a.outputSeq - b.outputSeq);
      for (const frame of matching) {
        if (!applyFrame(frame)) { buffer(frame); rerun = true; }
      }
      if (buffered.some(frame => frame.runId !== snapshot.runId || frame.terminalEpoch !== snapshot.terminalEpoch)) rerun = true;
    }
    async function sync(operation?: () => Promise<TerminalSnapshot | null>) {
      if (disposed) return;
      if (syncing) { rerun = true; return; }
      syncing = true;
      term.options.disableStdin = true;
      rerun = false;
      overflowed = false;
      try {
        const snapshot = await (operation ? operation() : bridge.invoke('shell.snapshot', { sessionId: session.id }));
        install(snapshot);
      } catch (err) { fail(err); }
      finally {
        syncing = false;
        if (!disposed) {
          term.options.disableStdin = !live.current.online || !live.current.canControl || live.current.session.state !== 'running';
          if (rerun) { rerun = false; void sync(); }
          else if (resizeWanted) { resizeWanted = false; void resize(); }
        }
      }
    }
    // Register first so output emitted while snapshot creation is pending cannot fall into a gap.
    const unsubscribe = bridge.onEvent(event => {
      if (event.type !== 'terminal.output' || event.sessionId !== session.id) return;
      if (syncing || !identity) { buffer(event); if (!syncing) void sync(); return; }
      if (!applyFrame(event)) { buffer(event); void sync(); }
    });
    async function input(data: string) {
      const current = identity;
      if (!current || !live.current.online || !live.current.canControl || live.current.session.state !== 'running' || syncing) return;
      // Inputs are never automatically retried: uncertain delivery must not execute a command twice.
      try {
        await bridge.invoke('shell.input', { sessionId: session.id, runId: current.runId, terminalEpoch: current.terminalEpoch, inputId: crypto.randomUUID(), data });
      } catch (err) { fail(err); }
    }
    const keyboard = term.onData(data => { void input(data); });
    async function start() {
      if (!live.current.online || !live.current.canControl || disposed) return;
      setBusy(true); setError('');
      try {
        const dimensions = fittedDimensions();
        if (dimensions) term.resize(dimensions.cols, dimensions.rows);
        const updated = await bridge.invoke('shell.start', { sessionId: session.id, cols: term.cols, rows: term.rows });
        if (disposed) return;
        live.current.onChange(updated);
        await sync();
        term.focus();
      } catch (err) { fail(err); }
      finally { if (!disposed) setBusy(false); }
    }
    async function terminate() {
      const current = identity;
      if (!current || !live.current.online || !live.current.canControl) return;
      setBusy(true); setError('');
      try {
        const updated = await bridge.invoke('shell.terminate', { sessionId: session.id, runId: current.runId });
        if (!disposed) live.current.onChange(updated);
      } catch (err) { fail(err); }
      finally { if (!disposed) setBusy(false); }
    }
    actions.current = { start: () => { void start(); }, interrupt: () => { void input('\x03'); term.focus(); }, terminate: () => { void terminate(); }, focus: () => term.focus(), refresh: () => { void sync().then(() => { if (!disposed) void resize(); }); } };
    function fittedDimensions() {
      const dimensions = fit.proposeDimensions();
      return dimensions ? { cols: Math.min(500, Math.max(2, dimensions.cols)), rows: Math.min(200, Math.max(2, dimensions.rows)) } : null;
    }
    async function resize() {
      if (!live.current.canControl) return;
      if (syncing) { resizeWanted = true; return; }
      if (disposed || !container.current?.clientWidth || !container.current.clientHeight) return;
      const dimensions = fittedDimensions();
      if (!dimensions) return;
      const current = identity;
      if (!current || !live.current.online || !live.current.canControl || live.current.session.state !== 'running') { term.resize(dimensions.cols, dimensions.rows); return; }
      if (dimensions.cols === current.cols && dimensions.rows === current.rows) return;
      // Consume the resize snapshot before applying output emitted while resizing.
      await sync(() => bridge.invoke('shell.resize', { sessionId: session.id, runId: current.runId, terminalEpoch: current.terminalEpoch, cols: dimensions.cols, rows: dimensions.rows }));
    }
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { void resize(); }, 100); });
    observer.observe(container.current!);
    void sync().then(() => { if (!disposed) void resize(); });
    return () => {
      disposed = true; actions.current = null; unsubscribe(); keyboard.dispose(); observer.disconnect(); clearTimeout(resizeTimer); term.dispose();
      // Leaving a tab only disposes its view; the computer keeps the Shell process alive.
    };
  }, [bridge, session.id]);

  useEffect(() => { if (online) actions.current?.refresh(); }, [online, session.runId, session.state, canControl]);

  const running = session.state === 'running';
  return <section className={`terminal-workspace ${!canControl ? 'terminal-readonly' : ''}`} aria-label="Shell 工作区">
    <div className="terminal-caption"><span><i className={`dot ${running ? '' : 'quiet'}`} /> <b>Shell</b><span>{stateNames[session.state]}</span></span><span className="terminal-location">{bridge.kind === 'browser' ? '电脑端 · 本地运行' : '此电脑 · 本地运行'}</span></div>
    {(error || session.error) && <div className="terminal-error" role="alert">{error || session.error}</div>}
    <div className="terminal-body">
      <div className="xterm-container" ref={container} aria-label="终端输入与输出" />
      {!ready && !hasOutput && <div className="terminal-start"><Icon name="terminal" /><h2>{session.state === 'interrupted' ? '上次运行已中断' : session.state === 'exited' ? 'Shell 已结束' : '在这里，直接运行命令'}</h2><p>工作目录：<code>{session.initialCwd}</code></p><p>{!canControl ? '当前为只读查看，接管后可以启动 Shell。' : '点击启动后，在此电脑上打开真实 Shell。'}</p><button className="primary" disabled={!online || !canControl || busy || running} onClick={() => actions.current?.start()}><Icon name="play" />{busy ? '正在启动…' : '启动 Shell'}</button></div>}
    </div>
    <div className="terminal-controls">
      <button disabled={!online || !canControl || !running || !ready || busy} onClick={() => actions.current?.interrupt()}><Icon name="stop" />中断命令 <kbd>Ctrl C</kbd></button>
      {running ? <button className="end-shell" disabled={!online || !canControl || busy} onClick={() => actions.current?.terminate()}>{busy ? '正在结束…' : '结束 Shell'}</button> : <button disabled={!online || !canControl || busy} onClick={() => actions.current?.start()}><Icon name="play" />{busy ? '正在启动…' : ready ? '重新启动' : '启动 Shell'}</button>}
      <span>{!canControl ? '只读查看 · 可横向滚动查看完整终端' : !ready && hasOutput ? 'Shell 已结束，保留最后的输出' : '切换会话后，运行继续保留'}</span>
    </div>
  </section>;
}
