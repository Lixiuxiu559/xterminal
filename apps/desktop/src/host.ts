import { join } from 'node:path';
import { SessionHost } from '../../../packages/host/src/controller.ts';
import type { RpcRequest } from '../../../packages/protocol/src/desktop.ts';
const port = process.parentPort;
if (!port) throw new Error('Session Host requires Electron utility process');
let host: SessionHost | null = null;
port.on('message', async ({ data }: { data: unknown }) => {
  try {
    if (!data || typeof data !== 'object') return;
    const envelope = data as { type?: string; dataPath?: string; shell?: string; request?: RpcRequest; id?: string; path?: string };
    switch (envelope.type) {
      case 'initialize':
        if (host || typeof envelope.dataPath !== 'string' || typeof envelope.shell !== 'string') throw new Error('Host initialize rejected');
        host = new SessionHost({ dbPath: join(envelope.dataPath, 'xterminal.sqlite'), schemaPath: join(__dirname, 'schema.sql'), shell: envelope.shell,
          uiPath: join(__dirname, '../ui'),
          emit: event => port.postMessage({ type: 'event', event }),
        });
        await host.ready();
        port.postMessage({ type: 'ready', snapshot: host.bootstrap() }); break;
      case 'request':
        if (!host) throw new Error('Host not ready');
        port.postMessage({ type: 'response', response: await host.handle(envelope.request) }); break;
      case 'project.add':
        if (!host || typeof envelope.path !== 'string') throw new Error('Project path invalid');
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: host.addProject(envelope.path) } }); break;
      case 'certificate.path':
        if (!host) throw new Error('Host not ready');
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: host.publicCertificatePath() } }); break;
      case 'active-count':
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: host?.activeCount() ?? 0 } }); break;
      case 'prepare-shutdown':
        if (!host) throw new Error('Host not ready');
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: await host.prepareShutdown() } }); break;
      case 'cancel-shutdown':
        host?.cancelShutdown();
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: null } }); break;
      case 'shutdown':
        await host?.close(); host = null;
        port.postMessage({ type: 'response', response: { id: envelope.id, ok: true, result: null } });
        port.postMessage({ type: 'shutdown-complete' }); break;
    }
  } catch (error) {
    const e = error as Error & { code?: string };
    const envelope = data as { id?: string; request?: RpcRequest };
    port.postMessage({ type: 'response', response: { id: envelope.request?.id ?? envelope.id ?? '', ok: false, error: { code: e.code ?? 'HOST_ERROR', message: e.message } } });
    if (!host) port.postMessage({ type: 'fatal', message: e.message });
  }
});
