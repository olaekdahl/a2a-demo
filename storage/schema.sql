-- Operation Echo Shield — shared A2A persistence schema (SQLite).
-- Applied idempotently at startup by the Python services (registry, command,
-- dashboard). Go and TypeScript agents never touch this database.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Registered A2A agents (one row per discovered service).
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT UNIQUE NOT NULL,
  language      TEXT,
  base_url      TEXT,
  health_status TEXT DEFAULT 'unknown',
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The raw Agent Card JSON fetched from each agent's well-known URL.
CREATE TABLE IF NOT EXISTS agent_cards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  card_json  TEXT NOT NULL,
  version    TEXT,
  fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One row per mission run.
CREATE TABLE IF NOT EXISTS missions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  objective     TEXT,
  context_id    TEXT UNIQUE,
  status        TEXT,
  phase         TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  final_summary TEXT
);

-- Every A2A message the Command Agent sends/receives (for the inspector).
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT,
  context_id    TEXT,
  task_id       TEXT,
  sender        TEXT,
  recipient     TEXT,
  direction     TEXT,                 -- 'outbound' | 'inbound'
  request_json  TEXT,
  response_json TEXT,
  headers_json  TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A2A tasks observed by the Command Agent on remote agents.
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT,
  context_id   TEXT,
  agent_name   TEXT,
  skill_id     TEXT,
  state        TEXT,
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);

-- Streamed/observed task status transitions (intel + fleet progress phases).
CREATE TABLE IF NOT EXISTS task_status_updates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT,
  context_id TEXT,
  agent_name TEXT,
  state      TEXT,
  phase      TEXT,
  message    TEXT,
  raw_json   TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Structured artifacts returned by agents.
CREATE TABLE IF NOT EXISTS artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id   TEXT,
  task_id       TEXT,
  context_id    TEXT,
  agent_name    TEXT,
  name          TEXT,
  media_type    TEXT,
  artifact_json TEXT,
  created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Human-friendly timeline of every A2A hop (drives the dashboard timeline/graph).
CREATE TABLE IF NOT EXISTS transmissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id   TEXT,
  task_id      TEXT,
  sender       TEXT,
  recipient    TEXT,
  label        TEXT,                  -- fun Star-Wars display label
  message_type TEXT,                  -- e.g. 'discover','message:send','message:stream','status','artifact','mission'
  direction    TEXT,
  status       TEXT,
  summary      TEXT,
  message_ref  TEXT,                  -- messages.message_id for the inspector
  created_at   TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Audit trail keyed by trace/correlation ids.
CREATE TABLE IF NOT EXISTS audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id       TEXT,
  correlation_id TEXT,
  actor          TEXT,
  action         TEXT,
  details_json   TEXT,
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Dead-letter queue: messages that exhausted all retries (populated only when
-- FAILURE_SIMULATION is on; demonstrates retry/backoff -> DLQ resilience).
CREATE TABLE IF NOT EXISTS dead_letters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id     TEXT,
  correlation_id TEXT,
  trace_id       TEXT,
  sender         TEXT,
  recipient      TEXT,
  skill_id       TEXT,
  attempts       INTEGER,
  last_error     TEXT,
  request_json   TEXT,
  created_at     TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deadletters_ctx    ON dead_letters(context_id, id);
CREATE INDEX IF NOT EXISTS idx_transmissions_ctx  ON transmissions(context_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_ctx        ON messages(context_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_msgid      ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_status_task         ON task_status_updates(task_id, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_ctx       ON artifacts(context_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_ctx           ON tasks(context_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_trace         ON audit_logs(trace_id, id);
