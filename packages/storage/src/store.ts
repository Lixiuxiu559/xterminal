import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { ProjectRecord, SessionRecord } from '../../protocol/src/desktop.ts';
import type { AgentMessage } from '../../protocol/src/agent.ts';
import type { DeviceRecord } from '../../lan/src/types.ts';

type Value = string | number | null;
export interface DBLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...values: Value[]): unknown;
    all(...values: Value[]): unknown[];
    run(...values: Value[]): unknown;
  };
  close(): void;
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
const projectColumns = 'id, name, root_path AS rootPath, created_at AS createdAt, updated_at AS updatedAt';
const sessionColumns = 'id, project_id AS projectId, engine, title, initial_cwd AS initialCwd, revision, last_seq AS lastSeq, created_at AS createdAt, updated_at AS updatedAt';

export class Store {
  private db: DBLike;
  private dbPath: string;

  constructor(dbPath: string, schemaPath: string, factory: (path: string) => DBLike = (path) => new Database(path)) {
    this.dbPath = dbPath;
    const existed = existsSync(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(dbPath), 0o700);
    if (!existed) closeSync(openSync(dbPath, 'wx', 0o600));
    chmodSync(dbPath, 0o600);
    this.db = factory(dbPath);
    try {
      // Check the version before changing an existing database's schema or journal mode.
      if (existed) {
        let versions: unknown[];
        try { versions = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(); }
        catch { throw failure('UNSUPPORTED_SCHEMA_VERSION', '数据库没有受支持的迁移版本'); }
        if (versions.length !== 1 || (versions[0] as { version: number }).version !== 1) {
          throw failure('UNSUPPORTED_SCHEMA_VERSION', '不支持此数据库迁移版本');
        }
      }
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
      if (!existed) this.transaction(() => { this.db.exec(readFileSync(schemaPath, 'utf8')); });
      this.secureFiles();
    } catch (error) {
      this.db.close();
      this.secureFiles();
      throw error;
    }
  }

  private secureFiles(): void {
    for (const path of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      this.secureFiles();
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listProjects(): ProjectRecord[] {
    return this.db.prepare(`SELECT ${projectColumns} FROM projects ORDER BY created_at, id`).all().map((row) => ({ ...(row as ProjectRecord) }));
  }

  addProject(rootPath: string): ProjectRecord {
    const canonical = realpathSync(rootPath);
    if (!statSync(canonical).isDirectory()) throw failure('INVALID_PROJECT_PATH', '项目路径必须是目录');
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT ${projectColumns} FROM projects WHERE root_path = ?`).get(canonical) as ProjectRecord | undefined;
      if (existing) return { ...existing };
      const now = new Date().toISOString();
      const project: ProjectRecord = { id: randomUUID(), name: basename(canonical) || canonical, rootPath: canonical, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO projects(id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(project.id, project.name, canonical, now, now);
      return project;
    });
  }

  listSessions(): SessionRecord[] {
    return this.db.prepare(`SELECT ${sessionColumns} FROM sessions ORDER BY created_at, id`).all().map((row) => ({ ...(row as SessionRecord) }));
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare(`SELECT ${sessionColumns} FROM sessions WHERE id = ?`).get(id) as SessionRecord | undefined;
    return row ? { ...row } : undefined;
  }

  private title(value: string): string {
    if (typeof value !== 'string' || value.trim().length < 1 || [...value.trim()].length > 60) {
      throw failure('INVALID_TITLE', '标题长度必须为 1 到 60 个字符');
    }
    return value.trim();
  }

  createSession(input: { id: string; projectId: string; engine: SessionRecord['engine']; title: string }): SessionRecord {
    if (!['claude', 'codex', 'shell'].includes(input.engine)) throw failure('INVALID_ENGINE', '不支持此引擎');
    if (typeof input.id !== 'string' || !input.id.trim()) throw failure('INVALID_COMMAND_ID', '创建命令 ID 不能为空');
    const title = this.title(input.title);
    return this.transaction(() => {
      const existing = this.getSession(input.id);
      if (existing) {
        // Preserve the original creation payload even after a subsequent rename.
        const receipt = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`session.create:${input.id}`) as { value_json: string } | undefined;
        const payload = JSON.stringify({ projectId: input.projectId, engine: input.engine, title });
        if (receipt?.value_json !== payload) throw failure('COMMAND_ID_REUSED', '创建命令 ID 已用于不同的请求');
        return existing;
      }
      const project = this.db.prepare(`SELECT ${projectColumns} FROM projects WHERE id = ?`).get(input.projectId) as ProjectRecord | undefined;
      if (!project) throw failure('PROJECT_NOT_FOUND', '项目不存在');
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO sessions(id, project_id, engine, title, initial_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.id, project.id, input.engine, title, project.rootPath, now, now);
      this.db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?)')
        .run(`session.create:${input.id}`, JSON.stringify({ projectId: input.projectId, engine: input.engine, title }));
      return this.getSession(input.id)!;
    });
  }

  renameSession(id: string, title: string, expectedRevision: number): SessionRecord {
    const trimmed = this.title(title);
    return this.transaction(() => {
      const session = this.getSession(id);
      if (!session) throw failure('SESSION_NOT_FOUND', '会话不存在');
      if (session.revision !== expectedRevision) throw failure('REVISION_CONFLICT', '会话版本已变化');
      this.db.prepare('UPDATE sessions SET title = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(trimmed, new Date().toISOString(), id);
      return this.getSession(id)!;
    });
  }

  beginRun(input: { id: string; sessionId: string; hostInstanceId: string }): void {
    this.transaction(() => {
      const session = this.getSession(input.sessionId);
      if (!session) throw failure('SESSION_NOT_FOUND', '会话不存在');
      this.db.prepare("INSERT INTO runs(id, session_id, host_instance_id, kind, status, started_at) VALUES (?, ?, ?, ?, 'starting', ?)")
        .run(input.id, input.sessionId, input.hostInstanceId, session.engine === 'shell' ? 'shell-process' : 'agent-turn', new Date().toISOString());
    });
  }

  finishRun(id: string, status: 'exited' | 'failed' | 'interrupted' | 'completed', errorCode?: string): void {
    if (!['exited', 'failed', 'interrupted', 'completed'].includes(status)) throw failure('INVALID_RUN_STATUS', '无效的运行结束状态');
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET status = ?, ended_at = ?, error_code = ? WHERE id = ? AND status IN ('starting', 'running', 'waiting', 'stopping')")
        .run(status, new Date().toISOString(), errorCode ?? null, id);
      this.db.prepare("UPDATE command_receipts SET state = ?, updated_at = ? WHERE json_extract(result_json, '$.runId') = ? AND state IN ('accepted', 'dispatched')")
        .run(status === 'failed' ? 'failed' : 'completed', new Date().toISOString(), id);
    });
  }

  recoverRuns(): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status IN ('starting', 'running', 'waiting', 'stopping')")
        .run(new Date().toISOString());
      this.db.prepare("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'").run();
      this.db.prepare("UPDATE command_receipts SET state = 'outcome_unknown', updated_at = ? WHERE state IN ('accepted', 'dispatched')")
        .run(new Date().toISOString());
    });
  }

  listAgentMessages(sessionId: string): AgentMessage[] {
    return this.db.prepare('SELECT id, run_id, role, status, content_json, created_at FROM messages WHERE session_id = ? ORDER BY created_at, rowid').all(sessionId)
      .map(row => {
        const value = row as { id: string; run_id: string; role: AgentMessage['role']; status: AgentMessage['status']; content_json: string; created_at: string };
        return { id: value.id, runId: value.run_id, role: value.role, text: (JSON.parse(value.content_json) as { text: string }).text, status: value.status, createdAt: value.created_at };
      });
  }

  private event(sessionId: string, runId: string, type: string, payload: unknown): number {
    this.db.prepare('UPDATE sessions SET last_seq = last_seq + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
    const session = this.getSession(sessionId);
    if (!session) throw failure('SESSION_NOT_FOUND', '会话不存在');
    this.db.prepare('INSERT INTO session_events(session_id, seq, id, revision, run_id, type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, session.lastSeq, randomUUID(), session.revision, runId, type, JSON.stringify(payload), new Date().toISOString());
    return session.lastSeq;
  }

  saveAgentMessage(sessionId: string, message: AgentMessage): void {
    this.transaction(() => {
      const previous = this.db.prepare('SELECT session_id, run_id, content_json FROM messages WHERE id = ?').get(message.id) as { session_id: string; run_id: string; content_json: string } | undefined;
      if (previous && (previous.session_id !== sessionId || previous.run_id !== message.runId)) throw failure('MESSAGE_ID_REUSED', '消息标识属于另一运行实例');
      const previousText = previous ? (JSON.parse(previous.content_json) as { text: string }).text : '';
      const delta = message.status === 'streaming' && message.text.startsWith(previousText);
      const sequence = this.event(sessionId, message.runId, delta ? 'message.delta' : 'message.completed', delta ? { messageId: message.id, text: message.text.slice(previousText.length) } : { message });
      this.db.prepare(`INSERT INTO messages(id, session_id, run_id, role, status, content_json, updated_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, content_json = excluded.content_json, updated_seq = excluded.updated_seq
        WHERE messages.session_id = excluded.session_id AND messages.run_id = excluded.run_id`)
        .run(message.id, sessionId, message.runId, message.role, message.status, JSON.stringify({ text: message.text }), sequence, message.createdAt);
    });
  }

  getEngineContext(sessionId: string): string | null {
    const row = this.db.prepare('SELECT native_context_id FROM engine_contexts WHERE session_id = ?').get(sessionId) as { native_context_id: string | null } | undefined;
    return row?.native_context_id ?? null;
  }

  saveEngineContext(sessionId: string, nativeId: string, providerVersion: string): void {
    this.transaction(() => {
      this.db.prepare(`INSERT INTO engine_contexts(session_id, native_context_id, provider_version, adapter_version, updated_at) VALUES (?, ?, ?, '0.1.0', ?)
        ON CONFLICT(session_id) DO UPDATE SET native_context_id = excluded.native_context_id, provider_version = excluded.provider_version, adapter_version = excluded.adapter_version, updated_at = excluded.updated_at`)
        .run(sessionId, nativeId, providerVersion, new Date().toISOString());
    });
  }

  acceptAgentTurn(input: { sessionId: string; runId: string; commandId: string; hostInstanceId: string; text: string; model?: string; principalId?: string }): { runId: string; duplicate: boolean } {
    return this.transaction(() => {
      const hash = createHash('sha256').update(JSON.stringify([input.text, input.model ?? null])).digest('hex');
      const principalId = input.principalId ?? 'desktop';
      const existing = this.db.prepare('SELECT payload_hash, state, result_json FROM command_receipts WHERE principal_id = ? AND session_id = ? AND command_id = ?')
        .get(principalId, input.sessionId, input.commandId) as { payload_hash: string; state: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== hash) throw failure('COMMAND_ID_REUSED', '发送标识已用于另一条消息');
        if (existing.state === 'outcome_unknown') throw failure('COMMAND_OUTCOME_UNKNOWN', '上次发送结果不确定，不能自动重发；请检查历史后决定下一步');
        return { runId: (JSON.parse(existing.result_json) as { runId: string }).runId, duplicate: true };
      }
      const session = this.getSession(input.sessionId);
      if (!session || session.engine === 'shell') throw failure('INVALID_ENGINE', '此操作需要 Agent 会话');
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO runs(id, session_id, host_instance_id, kind, status, started_at) VALUES (?, ?, ?, 'agent-turn', 'starting', ?)")
        .run(input.runId, input.sessionId, input.hostInstanceId, now);
      const messageId = randomUUID();
      const seq = this.event(input.sessionId, input.runId, 'run.started', { message: { id: messageId, runId: input.runId, role: 'user', status: 'completed', text: input.text, createdAt: now } });
      this.db.prepare("INSERT INTO messages(id, session_id, run_id, role, status, content_json, updated_seq, created_at) VALUES (?, ?, ?, 'user', 'completed', ?, ?, ?)")
        .run(messageId, input.sessionId, input.runId, JSON.stringify({ text: input.text }), seq, now);
      this.db.prepare("INSERT INTO command_receipts(principal_id, session_id, command_id, type, payload_hash, state, result_json, created_at, updated_at) VALUES (?, ?, ?, 'agent.turn.start', ?, 'accepted', ?, ?, ?)")
        .run(principalId, input.sessionId, input.commandId, hash, JSON.stringify({ runId: input.runId }), now, now);
      this.db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
        .run(`agent.model:${input.sessionId}`, JSON.stringify(input.model ?? null));
      return { runId: input.runId, duplicate: false };
    });
  }

  agentReceipt(sessionId: string, commandId: string, text: string, model?: string, principalId = 'desktop'): { runId: string } | null {
    const row = this.db.prepare('SELECT payload_hash, state, result_json FROM command_receipts WHERE principal_id = ? AND session_id = ? AND command_id = ?')
      .get(principalId, sessionId, commandId) as { payload_hash: string; state: string; result_json: string } | undefined;
    if (!row) return null;
    if (row.payload_hash !== createHash('sha256').update(JSON.stringify([text, model ?? null])).digest('hex')) throw failure('COMMAND_ID_REUSED', '发送标识已用于另一条消息或模型');
    if (row.state === 'outcome_unknown') throw failure('COMMAND_OUTCOME_UNKNOWN', '上次发送结果不确定，请检查历史，不要自动重发');
    return JSON.parse(row.result_json) as { runId: string };
  }

  markDispatched(sessionId: string, commandId: string, principalId = 'desktop'): void {
    this.transaction(() => {
      this.db.prepare("UPDATE command_receipts SET state = 'dispatched', updated_at = ? WHERE principal_id = ? AND session_id = ? AND command_id = ? AND state = 'accepted'")
        .run(new Date().toISOString(), principalId, sessionId, commandId);
    });
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return row ? JSON.parse(row.value_json) as T : null;
  }
  setSetting(key: string, value: unknown): void {
    this.transaction(() => { this.db.prepare('INSERT INTO settings(key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(value)); });
  }

  /** Internal DeviceRepository data; token hashes must never enter Bootstrap or UI summaries. */
  listDevices(): DeviceRecord[] {
    return this.db.prepare('SELECT id, display_name, token_hash, created_at, expires_at, revoked_at FROM devices ORDER BY created_at, id').all()
      .map(row => {
        const value = row as { id: string; display_name: string; token_hash: string; created_at: string; expires_at: string; revoked_at: string | null };
        return {
          id: value.id, name: value.display_name, tokenHash: value.token_hash,
          createdAtMs: Date.parse(value.created_at), expiresAtMs: Date.parse(value.expires_at),
          revokedAtMs: value.revoked_at === null ? null : Date.parse(value.revoked_at),
        };
      });
  }

  upsertDevice(device: DeviceRecord): void {
    if (!device || typeof device.id !== 'string' || !device.id || device.id.length > 128 ||
        typeof device.name !== 'string' || device.name.length > 80 || typeof device.tokenHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(device.tokenHash) || !Number.isSafeInteger(device.createdAtMs) ||
        !Number.isSafeInteger(device.expiresAtMs) || !(device.revokedAtMs === null || Number.isSafeInteger(device.revokedAtMs))) {
      throw failure('INVALID_DEVICE', '设备授权存储无效');
    }
    const createdAt = new Date(device.createdAtMs).toISOString();
    const expiresAt = new Date(device.expiresAtMs).toISOString();
    const revokedAt = device.revokedAtMs === null ? null : new Date(device.revokedAtMs).toISOString();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO devices(id, display_name, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, token_hash = excluded.token_hash,
        created_at = excluded.created_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at`)
        .run(device.id, device.name, device.tokenHash, createdAt, expiresAt, revokedAt);
    });
  }

  lastRun(sessionId: string): { id: string; status: string } | null {
    const row = this.db.prepare('SELECT id, status FROM runs WHERE session_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(sessionId) as { id: string; status: string } | undefined;
    return row ? { ...row } : null;
  }

  close(): void { this.db.close(); this.secureFiles(); }
}
