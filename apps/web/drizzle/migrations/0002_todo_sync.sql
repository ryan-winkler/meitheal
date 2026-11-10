-- Todo Sync Confirmations
-- Tracks bidirectional sync state between HA todo entities and Meitheal tasks.
-- Used for deduplication of inbound items and outbound push tracking.
-- Mirrors calendar_confirmations pattern.
CREATE TABLE IF NOT EXISTS todo_sync_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  ha_entity_id TEXT NOT NULL,
  ha_todo_uid TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ha.todo_sync',
  sync_direction TEXT NOT NULL DEFAULT 'inbound',
  payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_todo_sync_entity_uid ON todo_sync_confirmations(ha_entity_id, ha_todo_uid);
CREATE INDEX IF NOT EXISTS idx_todo_sync_task ON todo_sync_confirmations(task_id);
