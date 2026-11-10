---
type: "Decision"
title: "ADR 0005: HA Calendar Sync and Idempotency"
description: "Defines the calendar sync model and how repeated requests are handled."
---

# ADR 0005: HA Calendar Sync and Idempotency

## Status

Accepted

## Date

2026-02-28

## Context

Meitheal iteration 2 requires deterministic task->calendar integration with replay safety and persistent auditability.

## Decision

1. `POST /api/tasks/create` is the primary orchestration endpoint.
2. Persistence happens before integration call:
- task row
- domain events
- integration attempt (pending)
- audit record
3. Integration then calls Home Assistant `calendar.create_event` directly using:
- `SUPERVISOR_TOKEN` and `http://supervisor/core` when available
- `HA_BASE_URL` + `HA_TOKEN` fallback for local development
4. Idempotency is keyed by `idempotency_key` and replayed from persistent state.
5. Manual reconciliation endpoint (`/api/integrations/calendar/confirmation`) is idempotent on `taskId + confirmationId`.

## Consequences

- Duplicate calendar calls are suppressed on retries.
- Request/task traceability is auditable across DB and logs.
- Integration behavior remains deterministic under transient failures.
