---
type: "Runbook"
title: "Vertical Slice Runbook (Iteration 2+)"
description: "Understand the reference end-to-end task workflow."
---

# Vertical Slice Runbook (Iteration 2+)

## Flow

1. `POST /api/tasks/create`
- Creates task with optional framework payload.
- Emits domain events: task created, framework applied, integration sync requested.
- Persists task, event, integration attempt, and audit rows before integration call.
- Calls Home Assistant calendar service directly (`calendar.create_event`).

2. `POST /api/integrations/calendar/confirmation`
- Records calendar confirmation for a task.
- Emits integration audit log events.
- Uses idempotent persistence (`taskId + requestId`) for replay-safe callbacks.

3. `PUT /api/v1/projects/{id}/tasks` (compat mode)

4. Observability
- JSON log lines written to stdout for Alloy/Loki ingestion.

## Notes

This slice uses SQLite and Drizzle. Keep each group of task, event, integration attempt and audit writes in one libSQL write batch. The client pools connections and releases them after each standalone statement. A write batch keeps its statements together and rolls back the group if a statement fails.

Run `pnpm --filter @meitheal/tests test e2e/task-sync-persistence.spec.ts` to check calendar persistence and retry behavior after changing the database driver.
