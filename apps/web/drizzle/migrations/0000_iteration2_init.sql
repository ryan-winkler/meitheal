CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  endeavor_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  framework_payload TEXT NOT NULL DEFAULT '{}',
  calendar_sync_state TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  integration TEXT NOT NULL,
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  retry_after_seconds INTEGER,
  response_payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(idempotency_key, integration)
);

CREATE TABLE IF NOT EXISTS calendar_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  provider_event_id TEXT,
  source TEXT NOT NULL DEFAULT 'ha.create_event',
  payload TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, request_id)
);

CREATE TABLE IF NOT EXISTS audit_trail (
  audit_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_id TEXT,
  task_id TEXT,
  integration TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_request_idx ON tasks(request_id);
CREATE INDEX IF NOT EXISTS tasks_calendar_sync_state_idx ON tasks(calendar_sync_state);
CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at);
CREATE INDEX IF NOT EXISTS domain_events_task_idx ON domain_events(task_id);
CREATE INDEX IF NOT EXISTS domain_events_request_idx ON domain_events(request_id);
CREATE INDEX IF NOT EXISTS domain_events_created_idx ON domain_events(created_at);
CREATE INDEX IF NOT EXISTS integration_attempts_task_idx ON integration_attempts(task_id);
CREATE INDEX IF NOT EXISTS integration_attempts_request_idx ON integration_attempts(request_id);
CREATE INDEX IF NOT EXISTS calendar_confirmations_task_idx ON calendar_confirmations(task_id);
CREATE INDEX IF NOT EXISTS calendar_confirmations_request_idx ON calendar_confirmations(request_id);
CREATE INDEX IF NOT EXISTS audit_trail_request_idx ON audit_trail(request_id);
CREATE INDEX IF NOT EXISTS audit_trail_task_idx ON audit_trail(task_id);
CREATE INDEX IF NOT EXISTS audit_trail_created_idx ON audit_trail(created_at);
