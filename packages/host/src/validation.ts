import type { AppMethod, RequestMap, RpcRequest } from '../../protocol/src/desktop.ts';
export class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'HostError'; }
}
const methods = new Set<AppMethod>(['bootstrap', 'session.create', 'session.rename', 'shell.start', 'shell.input', 'shell.resize', 'shell.snapshot', 'shell.terminate', 'agent.snapshot', 'agent.turn.start', 'agent.turn.stop', 'agent.respond', 'engine.models', 'control.acquire', 'control.renew', 'control.release', 'lan.status', 'lan.enable', 'lan.disable', 'lan.rotateCode', 'lan.approve', 'lan.reject', 'lan.revoke', 'lan.exportCertificate']);
function fail(message: string): never { throw new HostError('INVALID_REQUEST', message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('请求必须是对象');
  return value as Record<string, unknown>;
}
function text(p: Record<string, unknown>, key: string, max = 128): string {
  const value = p[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`${key} 无效`);
  return value;
}
function integer(p: Record<string, unknown>, key: string, min: number, max: number): void {
  if (!Number.isSafeInteger(p[key]) || (p[key] as number) < min || (p[key] as number) > max) fail(`${key} 超出范围`);
}
function exact(p: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(p).some(key => !keys.includes(key))) fail('请求包含不支持的字段');
}
export function validateRequest(input: unknown): RpcRequest & { method: AppMethod } {
  const req = object(input);
  exact(req, ['id', 'method', 'params', 'control']);
  if (req.control !== undefined) {
    const control = object(req.control); exact(control, ['hostInstanceId', 'generation']);
    text(control, 'hostInstanceId'); integer(control, 'generation', 1, Number.MAX_SAFE_INTEGER);
  }
  text(req, 'id');
  const method = text(req, 'method') as AppMethod;
  if (!methods.has(method)) fail('不支持的操作');
  const p = object(req.params);
  if (Buffer.byteLength(JSON.stringify(req), 'utf8') > 65_536) throw new HostError('PAYLOAD_TOO_LARGE', '请求过大');
  switch (method) {
    case 'bootstrap': exact(p, []); break;
    case 'lan.status':
    case 'lan.disable':
    case 'lan.rotateCode':
    case 'lan.exportCertificate': exact(p, []); break;
    case 'lan.enable': exact(p, ['address', 'mode']); text(p, 'address', 45); if (p.mode !== undefined && p.mode !== 'http' && p.mode !== 'https') fail('连接模式无效'); break;
    case 'lan.approve':
    case 'lan.reject': exact(p, ['ticket']); text(p, 'ticket'); break;
    case 'lan.revoke': exact(p, ['deviceId']); text(p, 'deviceId'); break;
    case 'control.acquire':
    case 'control.renew':
    case 'control.release': exact(p, ['sessionId']); text(p, 'sessionId'); break;
    case 'session.create':
      exact(p, ['projectId', 'engine', 'title', 'commandId']);
      text(p, 'projectId'); text(p, 'title', 60); text(p, 'commandId');
      if (!['claude', 'codex', 'shell'].includes(p.engine as string)) fail('引擎无效');
      break;
    case 'session.rename':
      exact(p, ['sessionId', 'title', 'expectedRevision']);
      text(p, 'sessionId'); text(p, 'title', 60); integer(p, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER); break;
    case 'shell.start':
      exact(p, ['sessionId', 'cols', 'rows']); text(p, 'sessionId');
      integer(p, 'cols', 2, 500); integer(p, 'rows', 2, 200); break;
    case 'shell.input':
      exact(p, ['sessionId', 'runId', 'terminalEpoch', 'inputId', 'data']);
      for (const key of ['sessionId', 'runId', 'terminalEpoch', 'inputId']) text(p, key);
      if (typeof p.data !== 'string' || p.data.length === 0 || Buffer.byteLength(p.data) > 16_384) fail('终端输入无效或过长');
      break;
    case 'shell.resize':
      exact(p, ['sessionId', 'runId', 'terminalEpoch', 'cols', 'rows']);
      for (const key of ['sessionId', 'runId', 'terminalEpoch']) text(p, key);
      integer(p, 'cols', 2, 500); integer(p, 'rows', 2, 200); break;
    case 'shell.snapshot': exact(p, ['sessionId']); text(p, 'sessionId'); break;
    case 'shell.terminate': exact(p, ['sessionId', 'runId']); text(p, 'sessionId'); text(p, 'runId'); break;
    case 'agent.snapshot': exact(p, ['sessionId']); text(p, 'sessionId'); break;
    case 'agent.turn.start':
      exact(p, ['sessionId', 'text', 'commandId', 'model']); text(p, 'sessionId'); text(p, 'commandId');
      if (p.model !== undefined) text(p, 'model', 200);
      if (typeof p.text !== 'string' || !p.text.trim() || Buffer.byteLength(p.text) > 60_000) fail('消息为空或超过长度限制');
      break;
    case 'engine.models': exact(p, ['engine']); if (p.engine !== 'codex') fail('此引擎暂不支持模型列表'); break;
    case 'agent.turn.stop': exact(p, ['sessionId', 'runId']); text(p, 'sessionId'); text(p, 'runId'); break;
    case 'agent.respond': {
      exact(p, ['sessionId', 'runId', 'interactionId', 'answer']);
      for (const key of ['sessionId', 'runId', 'interactionId']) text(p, key);
      const answer = object(p.answer); exact(answer, ['action', 'answers']);
      if (!['allow-once', 'deny', 'cancel-turn', 'submit'].includes(answer.action as string)) fail('回答操作无效');
      if (answer.answers !== undefined) {
        const answers = object(answer.answers);
        if (Object.keys(answers).length > 32) fail('回答数量过多');
        for (const [key, values] of Object.entries(answers)) {
          if (!key || key.length > 256 || !Array.isArray(values) || values.length > 32 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16384)) fail('回答内容无效');
        }
      }
      break;
    }
  }
  return { id: req.id as string, method, params: p, ...(req.control ? { control: req.control as RpcRequest['control'] } : {}) };
}
export function parameters<K extends AppMethod>(request: RpcRequest, _method: K): RequestMap[K]['params'] {
  return request.params as RequestMap[K]['params'];
}
