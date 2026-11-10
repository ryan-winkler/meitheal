---
type: "Decision"
title: "ADR-0011: Task Activity Log Design"
description: "Defines the task activity history and its storage."
---

# ADR-0011: Task Activity Log Design

- **Status**: Accepted
- **Date**: 2026-02-28
- **Context**: Phase 30 competitive parity, Persona #34 (domain events)

## Decision

### Schema

```sql
CREATE TABLE task_activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX activity_log_task_id_idx ON task_activity_log(task_id);
```

### Recording Strategy

- **When**: On every tasks PUT that changes a field value
- **How**: Old values fetched before UPDATE, diff against sanitized new values
- **Insertion**: Fire-and-forget `Promise.all()` — doesn't block the PUT response
- **Actor**: Currently `'user'` — future: `'system'`, `'webhook'`, `'calendar_sync'`

### API

- `GET /api/tasks/[id]/activity` — returns last 100 change records, newest first

### Trade-offs

- Fire-and-forget means activity writes could fail silently
- No pagination beyond LIMIT 100 (sufficient for single-task views)
- String comparison for old/new diffs (works for all field types)
- CASCADE delete ensures no orphaned activity records

## Consequences

- Every field change on a task is auditable
- Task detail panel can show "Activity" tab with change history
- Future: extend to task creation, deletion, comment events
