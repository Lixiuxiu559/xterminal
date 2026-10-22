import { app, BrowserWindow, dialog } from 'electron';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AppSession, Bootstrap } from '../packages/protocol/src/desktop.ts';
import type { AgentSnapshot } from '../packages/protocol/src/agent.ts';
const phase = process.env.XTERMINAL_SMOKE_PHASE!;
const output = process.env.XTERMINAL_SMOKE_OUTPUT!;
const projectPath = process.env.XTERMINAL_SMOKE_PROJECT!;
const mode = process.env.XTERMINAL_AGENT_MODE!;
const fixture = mode === 'fixture';
const realTools = process.env.XTERMINAL_AGENT_TOOLS === '1';
const checks: string[] = [];
const errors: string[] = [];
interface Entry { engine: 'codex' | 'claude'; id: string; title: string; marker: string; messages: number }
const manifestPath = join(output, 'manifest.json');
let entries: Entry[] = [];
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projectPath] });
dialog.showMessageBox = async (...args: unknown[]) => { const options = args.at(-1) as { type?: string; message?: string }; if (options.type === 'error') errors.push(options.message ?? 'error dialog'); return { response: 1, checkboxChecked: false }; };
dialog.showErrorBox = (title, content) => { errors.push(`${title}: ${content}`); };
const evaluate = <T>(window: BrowserWindow, script: string): Promise<T> => window.webContents.executeJavaScript(script, true);
const invoke = <T>(window: BrowserWindow, method: string, params: unknown): Promise<T> => evaluate(window, `window.xterminal.invoke(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
async function until<T>(operation: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  while (true) { const value = await operation(); if (accept(value)) return value; if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 35)); }
}
async function loaded(window: BrowserWindow) {
  await until(() => evaluate<boolean>(window, '!!window.xterminal && !!document.querySelector(".new-session") && !document.querySelector(".new-session").disabled'), Boolean, 'React ready');
}
async function click(window: BrowserWindow, selector: string) {
  await until(() => evaluate<boolean>(window, `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`), Boolean, `enabled ${selector}`);
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function fill(window: BrowserWindow, selector: string, text: string) {
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  await window.webContents.insertText(text);
  await until(() => evaluate<string>(window, `document.querySelector(${JSON.stringify(selector)}).value`), value => value === text, `native input ${selector}`);
}
async function selectSession(window: BrowserWindow, entry: Entry) {
  await evaluate(window, `Array.from(document.querySelectorAll('.sidebar .session-button')).find(b => b.title === ${JSON.stringify(entry.title)}).click()`);
  await until(() => evaluate<boolean>(window, `!!document.querySelector('#message-${entry.id}') && !document.querySelector('.agent-loading')`), Boolean, `${entry.engine} pane ready`);
}
async function control(window: BrowserWindow) {
  if (await evaluate<boolean>(window, '!!document.querySelector(".readonly-banner")')) await click(window, '.readonly-banner button');
  await until(() => evaluate<boolean>(window, '!document.querySelector(".readonly-banner")'), Boolean, 'explicit control');
}
async function send(window: BrowserWindow, text: string) {
  await fill(window, '.agent-composer textarea', text); await click(window, '.agent-send');
}
async function finished(window: BrowserWindow, entry: Entry, expected?: string, approveTools = false) {
  const approved = new Set<string>();
  const state = await until(async () => {
    const snapshot = await invoke<Bootstrap>(window, 'bootstrap', {});
    if (approveTools && snapshot.sessions.find(session => session.id === entry.id)?.state === 'waiting') {
      const agent = await invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id });
      for (const interaction of agent.interactions) {
        if (approved.has(interaction.id)) continue;
        // Only the exact scratch-file command requested by this harness is authorized.
        const command = `printf '%s' '${entry.marker}' > e2e-${entry.engine}.txt`;
        assert.equal(interaction.kind, 'permission', 'unexpected real-model interaction');
        const detail = interaction.detail.replaceAll('＞', '>').replaceAll('＜', '<');
        const actualCommand = entry.engine === 'claude' ? detail.split('\n').find(line => line.startsWith('command: '))?.slice('command: '.length) : detail.split('\n')[0];
        assert.equal(actualCommand, command, 'unexpected real tool command requires manual review');
        if (entry.engine === 'claude') assert.ok(detail.split('\n').every(line => line.startsWith('description: ') || line === `command: ${command}`), 'unexpected additional tool input');
        await evaluate(window, 'Array.from(document.querySelectorAll(".interaction-actions button")).find(button => button.textContent === "允许本次").click()');
        approved.add(interaction.id);
      }
    }
    return snapshot;
  }, snapshot => {
    const session = snapshot.sessions.find(session => session.id === entry.id);
    return Boolean(session && ['idle', 'error', 'interrupted'].includes(session.state));
  }, `${entry.engine} finished`, fixture ? 15000 : 120000);
  const session = state.sessions.find(session => session.id === entry.id)!;
  assert.notEqual(session.state, 'error', session.error ?? 'Agent error');
  const snapshot = await invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id });
  if (expected) {
    const latestUser = snapshot.messages.findLast(message => message.role === 'user');
    assert.ok(latestUser, 'missing latest user turn');
    const latestAssistant = snapshot.messages.findLast(message => message.role === 'assistant' && message.runId === latestUser.runId && message.status === 'completed');
    assert.ok(latestAssistant, `missing latest assistant result: ${entry.engine}`);
    assert.ok(latestAssistant.text.includes(expected), `incorrect latest assistant result: ${entry.engine}`);
    await until(() => evaluate<string | undefined>(window, "Array.from(document.querySelectorAll('.role-assistant .message-text')).at(-1)?.textContent"), text => text === latestAssistant.text, 'latest assistant rendered');
  }
  assert.equal(snapshot.interactions.length, 0);
  await until(() => evaluate<boolean>(window, '!document.querySelector(".agent-stop")'), Boolean, 'composer returns idle');
  return snapshot;
}
async function screenshot(window: BrowserWindow, name: string) { await writeFile(join(output, name), (await window.webContents.capturePage()).toPNG()); }
async function run(window: BrowserWindow) {
  try {
    await loaded(window);
    const initial = await invoke<Bootstrap>(window, 'bootstrap', {});
    for (const engine of ['codex', 'claude']) assert.equal(initial.engines.find(item => item.engine === engine)?.available, true, `${engine} unavailable`);
    if (phase === 'first') {
      assert.equal(initial.projects.length, 0);
      for (const engine of ['codex', 'claude'] as const) {
        await click(window, '.sidebar .new-session');
        if (!initial.projects.length && engine === 'codex') await click(window, '.project-picker button');
        await click(window, `.engine-option:has(.engine-symbol.${engine})`);
        const title = `E2E ${engine}`;
        await fill(window, '#session-title', title);
        await click(window, '.create-dialog .modal-actions .primary');
        const catalog = await until(() => invoke<Bootstrap>(window, 'bootstrap', {}), state => state.sessions.some(session => session.title === title), 'session created');
        const session = catalog.sessions.find(session => session.title === title)!;
        assert.equal(session.engine, engine);
        const entry: Entry = { engine, title, id: session.id, marker: `E2E_${engine}_${randomUUID().replaceAll('-', '')}_中文🚀`, messages: 0 };
        entries.push(entry); await selectSession(window, entry);
        if (engine === 'codex') {
          const model = fixture ? 'e2e-codex-model' : process.env.XTERMINAL_CODEX_MODEL!;
          await until(() => evaluate<boolean>(window, `Array.from(document.querySelectorAll('.model-picker select option')).some(o => o.value === ${JSON.stringify(model)})`), Boolean, 'official model list', 30000);
          await evaluate(window, `const select = document.querySelector('.model-picker select'); select.value = ${JSON.stringify(model)}; select.dispatchEvent(new Event('change',{bubbles:true}))`);
        }
        await send(window, fixture ? `E2E_MESSAGE:${entry.marker}` : `请记住本次会话的标记「${entry.marker}」。只原样回复此标记，不使用工具，不读写文件。`);
        const snapshot = await finished(window, entry, entry.marker);
        assert.equal(snapshot.messages.filter(message => message.role === 'user').length, 1);
        assert.equal(snapshot.messages.filter(message => message.role === 'assistant' && message.text.includes(entry.marker)).length, 1);
        if (!fixture) assert.equal(snapshot.tools.length, 0, 'real short request must not use tools');
        checks.push(`${engine}: 真实弹窗创建、原生输入、发送、最终回答与渲染通过`);
        await screenshot(window, `${engine}-conversation.png`);
        if (!fixture && realTools) {
          const command = `printf '%s' '${entry.marker}' > e2e-${entry.engine}.txt`;
          await send(window, `请只用一次命令执行工具，在当前工作目录运行这条完整命令：${command}\n不要执行其他命令或读取其他文件，不联网。完成后只回复 E2E_TOOL_OK。`);
          const executed = await finished(window, entry, 'E2E_TOOL_OK', true);
          assert.equal(await readFile(join(projectPath, `e2e-${engine}.txt`), 'utf8'), entry.marker);
          assert.ok(executed.tools.some(tool => tool.state === 'completed'), 'real tool must be observed');
          checks.push(`${engine}: 真实工具执行仅写临时项目指定文件，内容核验与工具UI通过`);
          await screenshot(window, `${engine}-tool.png`);
        }
        if (fixture) {
          for (const [action, expected] of [['允许本次', 'E2E_ALLOWED'], ['拒绝操作', 'E2E_DENIED']]) {
            await send(window, 'E2E_APPROVAL');
            await until(() => evaluate<boolean>(window, '!!document.querySelector(".interaction-permission")'), Boolean, 'permission rendered');
            await evaluate(window, `Array.from(document.querySelectorAll('.interaction-actions button')).find(b => b.textContent === ${JSON.stringify(action)}).click()`);
            await finished(window, entry, expected);
          }
          checks.push(`${engine}: 权限卡片允许本次/拒绝均经原生请求完成`);
          await send(window, 'E2E_QUESTION');
          await until(() => evaluate<boolean>(window, 'document.querySelectorAll(".agent-question").length === 2'), Boolean, 'questions rendered');
          assert.equal(await evaluate(window, 'Array.from(document.querySelectorAll(".interaction-actions button")).find(b => b.textContent === "提交回答").disabled'), true);
          await click(window, '.agent-question:nth-of-type(1) .question-option input');
          await click(window, '.agent-question:nth-of-type(2) .question-option:nth-child(2) input');
          await fill(window, '.agent-question:nth-of-type(2) .question-custom input', '补充答案');
          await screenshot(window, `${engine}-question.png`);
          await evaluate(window, 'Array.from(document.querySelectorAll(".interaction-actions button")).find(b => b.textContent === "提交回答").click()');
          await finished(window, entry, 'E2E_ANSWERED');
          checks.push(`${engine}: 两题完整性、选项和自由回答经UI提交通过`);
          await send(window, 'E2E_STOP');
          await until(() => invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id }), snap => { const user = snap.messages.findLast(message => message.role === 'user'); return user?.text === 'E2E_STOP' && snap.messages.some(message => message.role === 'assistant' && message.runId === user.runId && message.status === 'streaming' && message.text.includes('部分')); }, 'active delta');
          if (engine === 'claude') {
            const before = (await invoke<Bootstrap>(window, 'bootstrap', {})).sessions.find(session => session.id === entry.id)!;
            window.close(); await until(() => BrowserWindow.getAllWindows().length, count => count === 0, 'all windows closed');
            const opened = new Promise<BrowserWindow>(resolveWindow => app.once('browser-window-created', (_event, next) => resolveWindow(next)));
            app.emit('activate'); window = await opened; await loaded(window); await selectSession(window, entry);
            const after = (await invoke<Bootstrap>(window, 'bootstrap', {})).sessions.find(session => session.id === entry.id)!;
            assert.equal(before.runId, after.runId); assert.equal(after.state, 'running');
            checks.push('Claude活跃轮次关窗后恢复同一run，无新发送');
          }
          await click(window, '.agent-stop');
          const stopped = await finished(window, entry);
          assert.ok(stopped.messages.some(message => message.status === 'interrupted'));
          checks.push(`${engine}: 停止等待原生终态，未把受理响应当结束`);
        }
        entry.messages = (await invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id })).messages.length;
      }
      // Unsent draft survives switching both engines in this renderer.
      const current = entries[1]!; await selectSession(window, current);
      await fill(window, '.agent-composer textarea', '未发送草稿');
      await selectSession(window, entries[0]!); await selectSession(window, current);
      assert.equal(await evaluate(window, 'document.querySelector(".agent-composer textarea").value'), '未发送草稿');
      checks.push('切换引擎会话后草稿保留且未发送');
      await writeFile(manifestPath, JSON.stringify(entries, null, 2));
    } else if (phase === 'crash') {
      assert.ok(fixture, 'crash injection never calls a model');
      entries = JSON.parse(await readFile(manifestPath, 'utf8'));
      const entry = entries[0]!;
      await selectSession(window, entry); await control(window); await send(window, 'E2E_STOP');
      await until(() => invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id }), snap => snap.messages.findLast(message => message.role === 'assistant')?.status === 'streaming', 'persisted crash partial');
      for (const item of entries) item.messages = (await invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: item.id })).messages.length;
      const database = new Database(join(process.env.XTERMINAL_TEST_DATA!, 'xterminal.sqlite'), { readonly: true });
      try {
        // Streaming deltas are coalesced for 50ms. Inject the fault after the
        // observable durable boundary, rather than treating RAM as committed WAL.
        await until(() => entries.every(item => (database.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(item.id) as { n: number }).n === item.messages), Boolean, 'partial committed to SQLite');
      } finally { database.close(); }
      await writeFile(manifestPath, JSON.stringify(entries, null, 2));
      // Resolve only this application's named utility, and recheck creation identity before signaling.
      const metric = app.getAppMetrics().find(metric => metric.type === 'Utility' && (metric.name === 'XTerminal Session Host' || metric.serviceName === 'XTerminal Session Host'));
      assert.ok(metric, 'own Session Host metric not found');
      assert.ok(app.getAppMetrics().some(current => current.pid === metric.pid && current.creationTime === metric.creationTime));
      process.kill(metric.pid, 'SIGKILL');
      await until(() => evaluate<boolean>(window, '!!document.querySelector(".offline")'), Boolean, 'production Host offline banner');
      assert.equal(await evaluate(window, 'document.querySelector(".agent-stop").disabled'), true);
      await assert.rejects(invoke(window, 'bootstrap', {}));
      await screenshot(window, 'host-crash-offline.png');
      checks.push('强杀本应用真实Host后页面离线、写操作禁用，不自动重启或重发');
    } else {
      entries = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(initial.sessions.length, entries.length);
      for (const entry of entries) {
        await selectSession(window, entry);
        const session = initial.sessions.find(session => session.id === entry.id)!;
        assert.equal(session.engine, entry.engine); assert.equal(session.runId, null);
        if (phase === 'crash-restart' && entry === entries[0]) assert.equal(session.state, 'interrupted');
        const restored = await invoke<AgentSnapshot>(window, 'agent.snapshot', { sessionId: entry.id });
        assert.equal(restored.messages.length, entry.messages);
        assert.ok(restored.messages.some(message => message.role === 'assistant' && message.text.includes(entry.marker)));
        if (phase === 'crash-restart' && entry === entries[0]) assert.equal(restored.messages.findLast(message => message.role === 'assistant')?.status, 'interrupted');
        assert.equal(await evaluate(window, 'document.querySelector(".agent-composer textarea").value'), '');
        await control(window);
        await send(window, fixture ? 'E2E_RESUME' : '请只原样回复我们上一轮约定的会话标记，不使用任何工具，不读写文件。');
        const continued = await finished(window, entry, entry.marker);
        assert.equal(continued.messages.filter(message => message.role === 'user').length, restored.messages.filter(message => message.role === 'user').length + 1);
        checks.push(`${entry.engine}: ${phase === 'crash-restart' ? '崩溃后' : ''}重启历史未重复、未自动发送；明确续聊恢复原生上下文标记`);
      }
    }
    assert.deepEqual(errors, []);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, `${phase}.json`), JSON.stringify({ passed: true, mode, phase, realModel: !fixture, hostInstanceId: initial.hostInstanceId, checks, at: new Date().toISOString() }, null, 2));
    app.quit();
  } catch (error) {
    console.error(error);
    try { if (!window.isDestroyed()) await screenshot(window, `${phase}-failure.png`); } catch { /* Preserve original failure. */ }
    await writeFile(join(output, `${phase}.json`), JSON.stringify({ passed: false, mode, phase, checks, errors, error: String(error), at: new Date().toISOString() }, null, 2));
    app.exit(1);
  }
}
let running = false;
app.on('browser-window-created', (_event, window) => { if (!running) { running = true; void run(window); } });
require(resolve('dist/desktop/main.cjs'));
