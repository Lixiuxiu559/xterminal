import { app, BrowserWindow, dialog, utilityProcess } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Bootstrap, DesktopBridge, AppSession } from '../packages/protocol/src/desktop.ts';
const phase = process.env.XTERMINAL_SMOKE_PHASE!;
const output = process.env.XTERMINAL_SMOKE_OUTPUT!;
const projectPath = process.env.XTERMINAL_SMOKE_PROJECT!;
const checks: string[] = [];
const dialogs: string[] = [];
const failures: string[] = [];
// Only this standalone smoke runner replaces native dialogs; product code does not.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
dialog.showMessageBox = async (...args: unknown[]) => {
  const options = args.at(-1) as { message?: string; type?: string };
  dialogs.push(options.message ?? 'dialog');
  if (options.type === 'error') failures.push(options.message ?? 'error dialog');
  return { response: 1, checkboxChecked: false };
};
dialog.showErrorBox = (title: string, content: string) => { failures.push(`${title}: ${content}`); };
async function until<T>(operation: () => Promise<T> | T, predicate: (value: T) => boolean, label: string, timeout = 12_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await operation(); if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise(res => setTimeout(res, 20));
  }
}
function evaluate<T>(window: BrowserWindow, script: string): Promise<T> { return window.webContents.executeJavaScript(script, true); }
function invoke<T>(window: BrowserWindow, method: string, params: unknown): Promise<T> {
  return evaluate(window, `window.xterminal.invoke(${JSON.stringify(method)},${JSON.stringify(params)})`);
}
async function loaded(window: BrowserWindow) {
  await until(() => !window.webContents.isLoading() && window.webContents.getURL().startsWith('app://'), Boolean, 'window loaded');
  await until(() => evaluate(window, '!!window.xterminal && !!document.querySelector("#root")?.children.length'), Boolean, 'React/preload loaded');
}
async function run(window: BrowserWindow) {
  try {
    await loaded(window);
    const isolation = await evaluate<{ node: string; bridge: string }>(window, '({node:typeof require,bridge:typeof window.xterminal})');
    assert.equal(isolation.node, 'undefined'); assert.equal(isolation.bridge, 'object');
    checks.push('真实 app:// 页面与受限 preload 加载成功，renderer 无 Node require');
    const initial = await invoke<Bootstrap>(window, 'bootstrap', {});
    const lan = await invoke<{ enabled: boolean; pairingCode?: string }>(window, 'lan.status', {});
    assert.equal(lan.enabled, false); assert.equal(lan.pairingCode, undefined);
    if (phase === 'restart') {
      assert.equal(initial.projects.length, 1); assert.equal(initial.sessions.length, 1);
      assert.equal(initial.sessions[0].title, '持久终端');
      assert.equal(initial.sessions[0].runId, null); assert.equal(initial.sessions[0].state, 'exited');
      const first = JSON.parse(await readFile(join(output, 'first.json'), 'utf8')) as { hostInstanceId: string };
      assert.notEqual(first.hostInstanceId, initial.hostInstanceId);
      checks.push('重新启动仍保留项目、会话与标题；旧 PTY 未自动启动');
    } else {
      assert.equal(initial.projects.length, 0);
      const project = await evaluate<{ id: string }>(window, 'window.xterminal.selectProject()');
      await evaluate(window, 'window.xterminal.selectProject()');
      assert.equal((await invoke<Bootstrap>(window, 'bootstrap', {})).projects.length, 1);
      checks.push('原生目录入口与 realpath 项目去重成功');
      await assert.rejects(invoke(window, 'project.add', { path: '/' }));
      await assert.rejects(invoke(window, 'session.create', { projectId: project.id, engine: 'invalid', title: '不可用', commandId: randomUUID() }));
      checks.push('非白名单操作和非法引擎被明确拒绝');
      await evaluate(window, 'document.querySelector(".phone-entry").click()');
      await until(() => evaluate<boolean>(window, 'document.querySelector(".lan-dialog")?.open && document.body.innerText.includes("开启内网连接")'), Boolean, 'LAN settings rendered');
      await writeFile(join(output, 'lan-settings.png'), (await window.webContents.capturePage()).toPNG());
      await evaluate(window, 'document.querySelector("[aria-label=关闭连接设置]").click()');
      checks.push('局域网默认关闭，真实连接设置显示IP选择与显式开启入口');
      const create = { projectId: project.id, engine: 'shell', title: 'Smoke Shell', commandId: randomUUID() };
      const session = await invoke<AppSession>(window, 'session.create', create);
      assert.equal((await invoke<AppSession>(window, 'session.create', create)).id, session.id);
      const started = await invoke<AppSession>(window, 'shell.start', { sessionId: session.id, cols: 80, rows: 24 });
      assert.equal(started.state, 'running'); assert.ok(started.runId);
      await assert.rejects(invoke(window, 'shell.start', { sessionId: session.id, cols: 80, rows: 24 }));
      checks.push('会话创建幂等，重复启动不会生成第二个活跃 PTY');
      const snapshot = await invoke<{ terminalEpoch: string }>(window, 'shell.snapshot', { sessionId: session.id });
      const input = (data: string) => invoke(window, 'shell.input', { sessionId: session.id, runId: started.runId, terminalEpoch: snapshot.terminalEpoch, inputId: randomUUID(), data });
      const marker = `DESKTOP_${randomUUID().replaceAll('-', '')}`;
      const command = `printf '%s%s\\n' '${marker.slice(0, 10)}' '${marker.slice(10)}'\r`;
      await input(command);
      await until(() => invoke<{ serializedState: string }>(window, 'shell.snapshot', { sessionId: session.id }), s => s.serializedState.includes(marker), 'PTY output');
      // Select the actual session through its visible navigation button.
      await until(() => evaluate<boolean>(window, `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes('Smoke Shell'))`), Boolean, 'session navigation');
      await evaluate(window, `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Smoke Shell')).click()`);
      await until(() => evaluate<boolean>(window, '!!document.querySelector(".xterm-screen")'), Boolean, 'xterm rendered');
      await until(() => evaluate<boolean>(window, `document.body.innerText.includes(${JSON.stringify(marker)})`), Boolean, 'terminal output rendered');
      const keyboardMarker = `keyboard_${randomUUID().replaceAll('-', '')}`;
      await evaluate(window, `window.__smokeKeys=[]; for(const type of ['keydown','keypress','keyup','input']) document.addEventListener(type,event=>window.__smokeKeys.push({type:event.type,key:event.key,data:event.data,target:event.target.className}),true)`);
      app.focus({ steal: true });
      window.focus(); window.webContents.focus();
      await evaluate(window, 'document.querySelector(".xterm-helper-textarea").focus()');
      for (const character of `printf '%s%s\\n' '${keyboardMarker.slice(0, 10)}' '${keyboardMarker.slice(10)}'`) {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: character });
        window.webContents.sendInputEvent({ type: 'char', keyCode: character });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: character });
      }
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
      try {
        await until(() => invoke<{ serializedState: string }>(window, 'shell.snapshot', { sessionId: session.id }), s => s.serializedState.includes(keyboardMarker), 'native keyboard input');
      } catch (error) {
        await writeFile(join(output, 'keyboard-diagnostic.json'), JSON.stringify({
          focused: window.isFocused(),
          dom: await evaluate(window, '({focus:document.hasFocus(),active:document.activeElement.className,keys:window.__smokeKeys,errors:Array.from(document.querySelectorAll("[role=alert]")).map(e=>e.textContent),textarea:document.querySelector(".xterm-helper-textarea").value})'),
          terminal: await invoke(window, 'shell.snapshot', { sessionId: session.id }),
        }, null, 2));
        throw error;
      }
      checks.push('真实窗口键盘输入经过 xterm onData 到达同一 PTY');
      await window.webContents.capturePage().then(image => writeFile(join(output, 'desktop-shell.png'), image.toPNG()));
      for (const width of [390, 768, 1440]) {
        window.setSize(width, 844);
        await until(() => evaluate<number>(window, 'window.innerWidth'), value => value === width, `viewport ${width}`);
        await until(() => evaluate<boolean>(window, 'document.querySelector(".xterm-screen").getBoundingClientRect().width <= document.querySelector(".xterm-container").clientWidth + 2'), Boolean, `terminal fitted ${width}`);
        const overflow = await evaluate<boolean>(window, 'document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth');
        assert.equal(overflow, false);
        if (width === 390) await window.webContents.capturePage().then(image => writeFile(join(output, 'mobile-shell.png'), image.toPNG()));
      }
      window.setSize(1320, 880);
      checks.push('390 / 768 / 1440px 真实窗口无页面横向溢出');
      checks.push('受限 IPC → Host → PTY → 快照 / xterm 的真实链路通过');
      await invoke(window, 'session.rename', { sessionId: session.id, title: '持久终端', expectedRevision: session.revision });
      await assert.rejects(invoke(window, 'session.rename', { sessionId: session.id, title: '旧版本', expectedRevision: session.revision }));
      const runId = started.runId;
      window.close();
      await until(() => BrowserWindow.getAllWindows().length, count => count === 0, 'window fully closed');
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      const newWindow = new Promise<BrowserWindow>(res => app.once('browser-window-created', (_event, win) => res(win)));
      app.emit('activate'); window = await newWindow; await loaded(window);
      const reopened = await invoke<Bootstrap>(window, 'bootstrap', {});
      assert.equal(reopened.sessions[0].runId, runId); assert.equal(reopened.sessions[0].state, 'running');
      assert.ok((await invoke<{ serializedState: string }>(window, 'shell.snapshot', { sessionId: session.id })).serializedState.includes(marker));
      checks.push('关闭全部窗口后 Host 与同一 PTY 保持，重新打开恢复相同 run 与输出');
      const utility = utilityProcess.fork(resolve('.smoke/shell.cjs'), [], { stdio: 'pipe' });
      utility.stdout?.resume(); utility.stderr?.resume();
      const shellChecks = await new Promise<string[]>((res, rej) => {
        const timer = setTimeout(() => { utility.kill(); rej(new Error('utility PTY smoke timeout')); }, 50_000);
        utility.once('message', result => { clearTimeout(timer); utility.kill(); result.ok ? res(result.assertions) : rej(new Error(result.message)); });
        utility.once('exit', code => { if (code !== 0) { clearTimeout(timer); rej(new Error(`utility exit ${code}`)); } });
      });
      checks.push(...shellChecks.map(check => `Electron utility: ${check}`));
    }
    assert.deepEqual(failures, []);
    await writeFile(join(output, `${phase}.json`), JSON.stringify({ phase, hostInstanceId: initial.hostInstanceId, checks, dialogs, passed: true, at: new Date().toISOString() }, null, 2));
    app.quit();
  } catch (error) {
    console.error(error);
    await writeFile(join(output, `${phase}.json`), JSON.stringify({ phase, checks, failures, error: String(error), passed: false }, null, 2));
    app.exit(1);
  }
}
let running = false;
app.once('will-quit', () => {
  const file = join(output, `${phase}.json`);
  if (!existsSync(file)) return;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (!report.passed) return;
  report.dialogs = dialogs;
  report.checks.push('应用收到 Host 完成确认后进入 will-quit；下次启动核验持久化终态');
  writeFileSync(file, JSON.stringify(report, null, 2));
});
app.on('browser-window-created', (_event, window) => { if (!running) { running = true; void run(window); } });
// Require the real product entry after installing the test-only native dialog fixture.
require(resolve(process.env.XTERMINAL_SMOKE_PACKAGE_ENTRY ?? 'dist/desktop/main.cjs'));
