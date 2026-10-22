import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, net, protocol, shell, utilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RpcResponse } from '../../../packages/protocol/src/desktop.ts';
import type { ControlStamp } from '../../../packages/protocol/src/index.ts';
import { validateRequest } from '../../../packages/host/src/validation.ts';

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const developmentUrl = !app.isPackaged ? process.env.XTERMINAL_DEV_URL : undefined;
if (developmentUrl && developmentUrl !== 'http://127.0.0.1:5173') throw new Error('Invalid development URL');
// Test runs always use an explicitly isolated data directory.
if (!app.isPackaged && process.env.XTERMINAL_TEST_DATA) app.setPath('userData', resolve(process.env.XTERMINAL_TEST_DATA));
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: Electron.UtilityProcess | null = null;
let quitting = false;
let quitPending = false;
let hostReady = false;
let readyResolve: (() => void) | null = null;
let readyReject: ((error: Error) => void) | null = null;
const ready = new Promise<void>((res, rej) => { readyResolve = res; readyReject = rej; });
// Handle initialization rejection even when the window has not requested data yet.
void ready.catch(() => {});
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout | undefined }>();

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('不可信的页面请求');
  const url = event.senderFrame.url;
  const parsed = new URL(url);
  const allowed = developmentUrl ? parsed.origin === developmentUrl : parsed.protocol === 'app:' && parsed.hostname === 'xterminal';
  if (!allowed) throw new Error('页面来源不受信任');
}
function request(envelope: object, timeoutMs = 15_000): Promise<unknown> {
  if (!host) return Promise.reject(new Error('本机会话服务不可用'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = timeoutMs > 0 ? setTimeout(() => { pending.delete(id); reject(new Error('操作结果未确认，请刷新状态后再继续')); }, timeoutMs) : undefined;
    pending.set(id, { resolve, reject, timer });
    host!.postMessage({ ...envelope, id });
  });
}
function domainRequest(method: string, params: unknown, control?: ControlStamp): Promise<unknown> {
  if (!host) return Promise.reject(new Error('本机会话服务不可用'));
  const id = randomUUID();
  const command = validateRequest({ id, method, params, ...(control ? { control } : {}) });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作结果未确认，请刷新状态后再继续')); }, 15_000);
    pending.set(id, { resolve, reject, timer }); host!.postMessage({ type: 'request', request: command });
  });
}
async function requestPublicCertificate(): Promise<{ saved: boolean }> {
  const certificatePath = await request({ type: 'certificate.path' });
  if (typeof certificatePath !== 'string') throw new Error('请先开启一次局域网访问，生成电脑的本地证书');
  const destination = await dialog.showSaveDialog(window!, { title: '导出局域网访问证书', defaultPath: 'XTerminal-Local-CA.crt', filters: [{ name: 'CA 证书', extensions: ['crt'] }] });
  if (destination.canceled || !destination.filePath) return { saved: false };
  await copyFile(certificatePath, destination.filePath);
  return { saved: true };
}
function notifyOffline(message: string): void {
  hostReady = false;
  readyReject?.(new Error(message));
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
  window?.webContents.send('xterminal:event', { type: 'host.offline', message });
}
function startHost(): void {
  host = utilityProcess.fork(join(__dirname, 'host.cjs'), [], { serviceName: 'XTerminal Session Host', stdio: 'pipe' });
  // Do not forward engine or PTY output to application logs.
  host.stdout?.resume(); host.stderr?.resume();
  host.on('message', (message: { type?: string; response?: RpcResponse; event?: unknown; message?: string }) => {
    if (message.type === 'ready') { hostReady = true; readyResolve?.(); }
    if (message.type === 'event') window?.webContents.send('xterminal:event', message.event);
    if (message.type === 'fatal') notifyOffline(message.message ?? '会话服务初始化失败');
    if (message.type === 'response' && message.response) {
      const response = message.response; const p = pending.get(response.id);
      if (!p) return; clearTimeout(p.timer); pending.delete(response.id);
      if (response.ok) p.resolve(response.result);
      else p.reject(Object.assign(new Error(response.error.message), { code: response.error.code }));
    }
    if (message.type === 'shutdown-complete') host?.kill();
  });
  host.on('exit', () => { host = null; if (!quitting) notifyOffline('本机会话服务已退出，请重新启动应用；原运行状态需要核验'); });
  host.postMessage({ type: 'initialize', dataPath: app.getPath('userData'), shell: process.env.SHELL || '/bin/zsh' });
}
function openWindow(): void {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({ width: 1320, height: 880, minWidth: 360, minHeight: 560, title: 'XTerminal',
    backgroundColor: '#fafbf8', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 19 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const current = developmentUrl ?? 'app://xterminal';
    if (!url.startsWith(current + '/') && url !== current) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('closed', () => { window = null; });
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadURL('app://xterminal/index.html');
}
async function shutdown(): Promise<void> {
  if (quitPending) return; quitPending = true;
  let shutdownStarted = false;
  let slowTimer: NodeJS.Timeout | undefined;
  try {
    if (hostReady) {
      const snapshot = await request({ type: 'prepare-shutdown' }) as { sessions: Array<{ title: string; runId: string | null }> };
      const active = snapshot.sessions.filter(session => session.runId);
      const count = active.length;
      if (count > 0) {
        const titles = active.map(session => session.title).join('\n');
        const answer = await dialog.showMessageBox({ type: 'warning', title: '退出 XTerminal', message: `有 ${count} 个会话仍在运行`, detail: `${titles}\n\n退出会结束这些任务。关闭窗口可保留运行。`, buttons: ['继续运行', '结束并退出'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) return;
      }
      shutdownStarted = true;
      slowTimer = setTimeout(() => {
        void dialog.showMessageBox({ type: 'info', message: '仍在等待终端结束', detail: '应用将在收到真实退出确认并保存记录后关闭。当前没有取消退出或重新启动任务。', buttons: ['继续等待'] });
      }, 20_000);
      // Once execution has begun, a local observation timeout must not turn it
      // into a cancelled shutdown. Keep the original request alive to completion.
      await request({ type: 'shutdown' }, 0);
    }
    quitting = true; tray?.destroy();
    // With an already-dead Host there was no await above. Defer the second quit
    // until the original before-quit handler has finished preventing its event.
    setImmediate(() => app.quit());
  } catch (error) {
    await dialog.showMessageBox({ type: 'error', message: '退出未完成', detail: `${(error as Error).message}\n\n已停止接收新任务。请检查磁盘或进程状态后，再次选择退出以重试清理。`, buttons: ['稍后重试'] });
    openWindow();
  } finally {
    clearTimeout(slowTimer);
    if (!shutdownStarted && !quitting && hostReady) await request({ type: 'cancel-shutdown' }).catch(() => {});
    quitPending = false;
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openWindow);
  app.whenReady().then(async () => {
    const dataPath = app.getPath('userData'); mkdirSync(dataPath, { recursive: true, mode: 0o700 }); chmodSync(dataPath, 0o700);
    const uiRoot = resolve(__dirname, '../ui');
    protocol.handle('app', async request => {
      const url = new URL(request.url);
      const file = resolve(uiRoot, '.' + decodeURIComponent(url.pathname));
      if (url.hostname !== 'xterminal' || (file !== uiRoot && !file.startsWith(uiRoot + sep))) return new Response('Forbidden', { status: 403 });
      if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, { status: response.status, headers });
    });
    startHost();
    ipcMain.handle('xterminal:invoke', async (event, request: unknown) => {
      trusted(event);
      try {
        await ready;
        if (!request || typeof request !== 'object') throw new Error('请求无效');
        const r = request as { method: string; params: unknown; control?: ControlStamp };
        if (r.method === 'lan.exportCertificate') {
          validateRequest({ id: randomUUID(), method: r.method, params: r.params });
          const certificate = await requestPublicCertificate();
          return { ok: true, result: certificate };
        }
        return { ok: true, result: await domainRequest(r.method, r.params, r.control) };
      } catch (error) {
        const failure = error as Error & { code?: string };
        return { ok: false, error: { code: failure.code ?? 'HOST_ERROR', message: failure.message } };
      }
    });
    ipcMain.handle('xterminal:select-project', async event => {
      trusted(event); await ready;
      const result = await dialog.showOpenDialog(window!, { title: '选择项目目录', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      return request({ type: 'project.add', path: result.filePaths[0] });
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'XTerminal', submenu: [{ role: 'about' }, { label: '显示窗口', click: openWindow }, { type: 'separator' }, { label: '退出 XTerminal', accelerator: 'CmdOrCtrl+Q', click: () => void shutdown() }] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    const bitmap = Buffer.alloc(22 * 22 * 4);
    for (let y = 0; y < 22; y++) for (let x = 0; x < 22; x++) {
      if ((x >= 4 && x <= 10 && (Math.abs(y - x - 1) <= 1 || Math.abs(y + x - 21) <= 1)) || (x >= 12 && x <= 18 && y >= 15 && y <= 16)) bitmap[(y * 22 + x) * 4 + 3] = 255;
    }
    const icon = nativeImage.createFromBitmap(bitmap, { width: 22, height: 22, scaleFactor: 1 });
    icon.setTemplateImage(true); tray = new Tray(icon); tray.setToolTip('XTerminal');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 XTerminal', click: openWindow }, { type: 'separator' }, { label: '退出', click: () => void shutdown() }]));
    tray.on('click', openWindow);
    openWindow();
  }).catch(error => { dialog.showErrorBox('XTerminal 启动失败', error.message); quitting = true; app.quit(); });
  app.on('activate', openWindow);
  app.on('window-all-closed', () => { /* Explicitly keep Host alive until application exit. */ });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
}
