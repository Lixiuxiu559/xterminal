import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, AppMethod, Bootstrap, DesktopBridge, RequestMap } from '../../../packages/protocol/src/desktop.ts';
import type { ControlLease, ControlStamp } from '../../../packages/protocol/src/index.ts';
const leases = new Map<string, ControlStamp>();
const listeners = new Set<(event: AppEvent) => void>();
let catalogVersion = 0;
function catalog(snapshot: Bootstrap): void {
  leases.clear();
  for (const session of snapshot.sessions) if (session.control?.principalId === 'desktop') leases.set(session.id, { hostInstanceId: session.control.hostInstanceId, generation: session.control.generation });
}
async function invoke<K extends AppMethod>(method: K, params: RequestMap[K]['params']): Promise<RequestMap[K]['result']> {
  const sessionId = 'sessionId' in params ? String(params.sessionId) : '';
  const control = leases.get(sessionId);
  const version = catalogVersion;
  const response = await ipcRenderer.invoke('xterminal:invoke', { method, params, ...(control ? { control } : {}) });
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  if (version === catalogVersion && method === 'bootstrap') catalog(response.result);
  if (version === catalogVersion && (method === 'control.acquire' || method === 'control.renew')) {
    const lease = response.result as ControlLease;
    leases.set(sessionId, { hostInstanceId: lease.hostInstanceId, generation: lease.generation });
  }
  if (version === catalogVersion && method === 'control.release') leases.delete(sessionId);
  if (version === catalogVersion && method === 'session.create' && response.result.control?.principalId === 'desktop') {
    const lease = response.result.control as ControlLease;
    leases.set(response.result.id, { hostInstanceId: lease.hostInstanceId, generation: lease.generation });
  }
  return response.result;
}
ipcRenderer.on('xterminal:event', (_event, event: AppEvent) => {
  if (event.type === 'catalog.changed') { catalogVersion++; catalog(event.snapshot); }
  if (event.type === 'host.offline') { catalogVersion++; leases.clear(); }
  for (const listener of listeners) { try { listener(event); } catch { /* A view cannot block lease updates or other views. */ } }
});
setInterval(() => {
  for (const [sessionId, stamp] of leases) {
    void invoke('control.renew', { sessionId }).catch(() => { if (leases.get(sessionId)?.generation === stamp.generation) leases.delete(sessionId); });
  }
}, 5000);
const bridge: DesktopBridge = {
  principalId: 'desktop', kind: 'desktop', invoke,
  selectProject: () => ipcRenderer.invoke('xterminal:select-project'),
  onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
contextBridge.exposeInMainWorld('xterminal', Object.freeze(bridge));
