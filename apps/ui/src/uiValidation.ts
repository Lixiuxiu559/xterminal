import type { AppSession } from '../../../packages/protocol/src/desktop.ts';
import type { EngineKind } from '../../../packages/protocol/src/index.ts';

export const MAX_AGENT_TEXT_BYTES = 60_000;
export const MAX_TITLE_LENGTH = 60;
const encoder = new TextEncoder();

/** Never interpret an inherited property (including __proto__) as a provider question's answer. */
export function ownValue<T>(record: Record<string, T>, key: string, fallback: T): T {
  return Object.hasOwn(record, key) ? record[key]! : fallback;
}
export function agentTextError(text: string): string {
  const bytes = encoder.encode(text.trim()).byteLength;
  return bytes > MAX_AGENT_TEXT_BYTES ? `消息为 ${bytes.toLocaleString('zh-CN')} 字节，超过 60,000 字节上限。请删减后再发送。` : '';
}
export function titleError(text: string): string {
  if (text.includes('\0')) return '会话名称不能包含空字符。';
  // Match the Host's current String.length limit; emoji can occupy two UTF-16 units.
  return text.trim().length > MAX_TITLE_LENGTH ? '会话名称最多 60 个字符（部分表情占 2 个字符）。' : '';
}
export function defaultSessionTitle(engine: EngineKind): string {
  return `新的 ${{ shell: 'Shell', claude: 'Claude Code', codex: 'Codex' }[engine]} 会话`;
}
const definiteRejections = new Set(['INVALID_REQUEST', 'PAYLOAD_TOO_LARGE', 'INVALID_ENGINE', 'ENGINE_UNAVAILABLE', 'SESSION_BUSY', 'PROJECT_BUSY', 'SESSION_NOT_FOUND', 'HOST_CLOSING', 'STORAGE_UNAVAILABLE', 'COMMAND_CONFLICT', 'CONTROL_REQUIRED', 'STALE_CONTROL']);
export function agentSendError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '操作未完成。';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && definiteRejections.has(code)
    ? `消息未发送：${message} 草稿已保留。`
    : `发送结果未确认，草稿已保留。请先检查会话记录，再决定是否发送。${message}`;
}

export function modelTurnParameters(engine: EngineKind, selectedModel: string): { model?: string } {
  return engine === 'codex' && selectedModel ? { model: selectedModel } : {};
}
export function restoreModelSelection(current: string, snapshotModel: string | null | undefined, userChanged: boolean): string {
  return userChanged || snapshotModel === undefined ? current : snapshotModel ?? '';
}

export function ownsSessionControl(session: Pick<AppSession, 'control'> | undefined, principalId = 'desktop'): boolean {
  return !!session?.control && session.control.principalId === principalId;
}
