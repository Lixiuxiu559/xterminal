import { runShellRuntimeSmoke } from '../packages/engines/shell/src/smoke.ts';
runShellRuntimeSmoke().then(result => process.parentPort?.postMessage({ ok: true, ...result })).catch(error => process.parentPort?.postMessage({ ok: false, message: error.stack }));
