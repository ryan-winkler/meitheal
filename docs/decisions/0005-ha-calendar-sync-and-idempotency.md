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

## Amendment (2026-11-21): Bidirectional Loop Prevention, Ticket Details & In-Ticket Confirmation

1. **Shared loop-prevention helpers (`apps/web/src/domains/calendar/calendar-event-identity.ts`)**: Both HA Calendar (including Google Calendar via HA) and WebDAV/CalDAV inbound syncs use `isMeithealOriginatedEvent` (handling `Added from Meitheal`, due-date reminder summaries/descriptions across `MTH-*` and custom board keys, nested prefixes, and HTML-wrapped Google Calendar descriptions) and `normalizeCalendarDescription`.
2. **Due-date reminder loop prevention (`apps/web/src/domains/notifications/due-date-reminders.ts`)**:
<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b05faf579e99bccb2b4c4353d9188db4467b6cefb81871f3141794976fe39c9d -->

   - Import-only calendars receive no reminder. For the same task, `calendarReminder` checks `calendar_confirmations` again immediately before delivery: a non-reminder receipt covers the destination when its payload’s `entity_id` matches. A receipt also covers this occurrence when either its request ID or provider event ID equals `due-reminder-<receiver binding ID>-<task ID>-<due timestamp in ms>`. A durable delivery reservation covers the task, entity and due timestamp while local confirmation and activity writes retry independently.

<!-- /coderabbit-ai-generated:v1 -->
   - Appends a blank line, optional ticket details (`📋 <ticket_key>` + direct Meitheal link, controlled by `calendar_write_ticket_details`, default `true`), and `Added from Meitheal` attribution, and records a deterministic `ha.due_reminder` confirmation plus an in-ticket `task_activity_log` entry.
3. **Outbound ticket details & in-ticket confirmation (`apps/web/src/domains/calendar/calendar-bridge.ts`)**:
   - Bidirectional and export calendar syncs expose `calendar_write_ticket_details` (default `true`) to include a blank line, ticket key, and direct Meitheal link while keeping `Added from Meitheal` attribution even when disabled.
   - Successful outbound calendar write-backs and due-date calendar reminders record a `calendar_sync` confirmation entry in `task_activity_log`.
