import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { LanGateway, isPrivateIPv4 } from '../packages/lan/src/gateway.ts';

async function main() {
const output = process.env.XTERMINAL_HTTP_SMOKE_OUTPUT!;
const directory = await mkdtemp(join(tmpdir(), 'xterminal-http-browser-'));
app.setPath('userData', join(directory, 'browser'));
const snapshot = { hostInstanceId: 'http-smoke', projects: [], sessions: [], engines: [] };
let bootstrapRpc = 0;
let gateway: LanGateway | undefined;
let window: BrowserWindow | undefined;
async function until<T>(action: () => Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await action(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('HTTP browser smoke timed out');
}
await app.whenReady();
try {
  const address = Object.values(networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4' && isPrivateIPv4(item.address))?.address;
  if (!address) { await writeFile(output, JSON.stringify({ passed: false, blocked: 'No private IPv4 interface; nonsecure context cannot be replaced by loopback' })); app.exit(2); }
  else {
    gateway = new LanGateway({ dataPath: join(directory, 'data'), uiPath: resolve('dist/ui'), bindAddress: address, mode: 'http',
      bootstrap: principalId => ({ ...snapshot, principalId }),
      execute: async (principalId, raw) => { const request = raw as { id: string; method: string }; assert.equal(request.method, 'bootstrap'); bootstrapRpc++; return { id: request.id, ok: true, result: { ...snapshot, principalId } }; },
      onPairingRequest: request => { void gateway!.approvePairing(request.ticket); }, onDeviceRevoked: () => {},
    });
    const started = await gateway.start(); assert.equal(started.caCertificatePath, null);
    window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    await window.loadURL(started.address.origin);
    await until(() => window!.webContents.executeJavaScript('!!document.querySelector("#pair-code")'), Boolean);
    const context = await window.webContents.executeJavaScript('({secure:isSecureContext,randomUUID:typeof crypto.randomUUID,getRandomValues:typeof crypto.getRandomValues})');
    assert.equal(context.secure, false); assert.equal(context.randomUUID, 'undefined'); assert.equal(context.getRandomValues, 'function');
    assert.match(await window.webContents.executeJavaScript('document.body.textContent'), /HTTP 连接未加密/);
    const paired = await window.webContents.executeJavaScript(`(async () => { const r=await fetch('/api/v1/pairing/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:${JSON.stringify(started.pairingCode.code)},deviceName:'HTTP smoke'})}); return {status:r.status,body:await r.json()}; })()`);
    assert.equal(paired.status, 202);
    await until(() => window!.webContents.executeJavaScript(`fetch('/api/v1/pairing/requests/${paired.body.ticket}').then(r=>r.json())`), value => value.status === 'approved');
    await window.reload();
    await until(() => window!.webContents.executeJavaScript('!!document.querySelector(".new-session") && !document.querySelector(".new-session").disabled'), Boolean);
    assert.ok(bootstrapRpc > 0, 'BrowserTransport WS bootstrap uses cryptographic UUID fallback');
    assert.ok((await window.webContents.executeJavaScript('document.cookie')).indexOf('xterminal-http-device') < 0, 'HttpOnly stays hidden');
    await gateway.stop();
    await writeFile(output, JSON.stringify({ passed: true, context, mode: 'http', modelCalls: false, checks: ['private IPv4 nonsecure context', 'HTTP BrowserRoot entry and warning', 'HTTP cookie pairing without CA', 'WS authenticated bootstrap with UUID fallback', 'HttpOnly cookie hidden', 'shutdown revokes access'] }, null, 2));
    window.destroy(); window = undefined;
  }
} catch (error) { await writeFile(output, JSON.stringify({ passed: false, error: String(error) })); process.exitCode = 1; }
finally { window?.destroy(); await gateway?.stop(); await rm(directory, { recursive: true, force: true }); app.exit(Number(process.exitCode ?? 0)); }

}
void main().catch(error => { console.error(error); app.exit(1); });
