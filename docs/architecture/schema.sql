PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex', 'shell')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 60),
  initial_cwd TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  last_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER sessions_engine_immutable
BEFORE UPDATE OF engine ON sessions
WHEN NEW.engine <> OLD.engine
BEGIN
  SELECT RAISE(ABORT, 'SESSION_ENGINE_IMMUTABLE');
END;

CREATE TRIGGER sessions_project_immutable
BEFORE UPDATE OF project_id, initial_cwd ON sessions
WHEN NEW.project_id <> OLD.project_id OR NEW.initial_cwd <> OLD.initial_cwd
BEGIN
  SELECT RAISE(ABORT, 'SESSION_PROJECT_IMMUTABLE');
END;

CREATE TABLE engine_contexts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  native_context_id TEXT,
  provider_version TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  host_instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('agent-turn', 'shell-process')),
  status TEXT NOT NULL CHECK(status IN (
    'starting', 'running', 'waiting', 'stopping', 'completed',
    'interrupted', 'failed', 'exited'
  )),
  native_turn_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT,
  UNIQUE(id, session_id)
) STRICT;
CREATE UNIQUE INDEX one_active_run_per_session ON runs(session_id)
WHERE status IN ('starting', 'running', 'waiting', 'stopping');

CREATE TABLE session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL CHECK(seq > 0),
  id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  run_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(session_id, seq),
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  status TEXT NOT NULL CHECK(status IN ('streaming', 'completed', 'interrupted')),
  content_json TEXT NOT NULL CHECK(json_valid(content_json)),
  updated_seq INTEGER NOT NULL CHECK(updated_seq >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id)
) STRICT;
CREATE INDEX messages_by_session ON messages(session_id, created_at, id);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  run_id TEXT NOT NULL,
  native_request_id_json TEXT NOT NULL CHECK(json_valid(native_request_id_json)),
  kind TEXT NOT NULL CHECK(kind IN ('permission', 'question', 'plan', 'elicitation', 'unsupported')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'resolving', 'resolved', 'cancelled', 'outcome_unknown')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(run_id, session_id) REFERENCES runs(id, session_id),
  UNIQUE(run_id, native_request_id_json)
) STRICT;

CREATE TABLE command_receipts (
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  command_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('accepted', 'dispatched', 'completed', 'failed', 'outcome_unknown')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(principal_id, session_id, command_id)
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK(json_valid(value_json))
) STRICT;

-- Pairing codes, control leases, raw PTY input/output and certificate private keys
-- are deliberately absent. Secrets never belong in the event journal.
INSERT INTO schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
