# Phase 13: Todo Outbound Delete Sync - Research

**Researched:** 2026-03-16
**Domain:** HA todo integration / outbound sync
**Confidence:** HIGH

## Summary

When a Meitheal task is deleted, the corresponding HA todo item is orphaned. This gap exists because `sync-outbound.ts` only handles `task.created` and `task.updated` events — `task.deleted` is ignored. The `DELETE /api/tasks/[id]` handler already cleans up calendar events but not todo items.

All required infrastructure exists: `removeTodoItem()` wraps HA's `todo.remove_item` service, the `todo_sync_confirmations` table maps `task_id → ha_entity_id + ha_todo_uid + payload`, and the outbound sync pattern from `pushTaskToTodoList()` shows how to look up sync confirmations and call HA services.

Additionally, HA 2026.3 introduced a new `remove_item` voice intent. Meitheal already has `MeithealDeleteTask` intent + `meitheal_delete_task` LLM tool that delete from Meitheal's DB. A complementary `RemoveFromTodoListTool` would allow agents to remove items from HA lists without deleting the Meitheal task.

**Primary recommendation:** Wire `task.deleted` through outbound sync, add `removeTaskFromTodoList()` to the todo bridge, and add a `RemoveFromTodoListTool` to the LLM API.

## Standard Stack

No new dependencies. All work uses existing:
- `home-assistant-js-websocket` — `callService()` for `todo.remove_item`
- `@libsql/client` — sync confirmation queries
- `@meitheal/domain-observability` — structured logging
- `voluptuous` — Python schema validation for LLM tool

## Architecture Patterns

### Outbound Sync Pipeline

```
task CRUD → dispatchTaskEvent() → pushToActiveSyncs() → todo-bridge / calendar-bridge
```

The `sync-outbound.ts` dispatcher receives events from `webhook-dispatcher.ts` and fans out to active sync targets. Currently only `task.created` and `task.updated` trigger outbound — `task.deleted` is filtered out on line 66.

### Sync Confirmation Table

```sql
todo_sync_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,        -- Meitheal task UUID
  ha_entity_id TEXT NOT NULL,   -- e.g. "todo.shopping_list"
  ha_todo_uid TEXT NOT NULL,    -- HA item identifier
  payload TEXT,                 -- JSON with {summary, status}
  sync_direction TEXT           -- "inbound" | "outbound"
)
```

To remove an item: query by `task_id`, extract `ha_entity_id` + `payload.summary`, call `removeTodoItem(entityId, [summary])`, delete confirmation rows.

### LLM Tool Pattern

Tools inherit from `homeassistant.helpers.llm.Tool`. Each has `name`, `description`, `parameters` (voluptuous schema), and `async_call()`. Tools are registered in `MeithealLLMAPI.async_get_api_instance()`.

## Don't Hand-Roll

| Problem | Use Instead | Why |
|---------|-------------|-----|
| HA todo item removal | `removeTodoItem()` from `ha-services.ts` | Already wraps `callService(conn, "todo", "remove_item", ...)` |
| Sync loop prevention | `todo_sync_confirmations` table | Existing pattern with `"synced from"` label check |
| Event dispatching | `dispatchTaskEvent()` | Already fires `task.deleted` — just need consumer |

## Common Pitfalls

### HA Identifies Todo Items by Summary Text
HA's `todo.remove_item` service requires the item summary text as the identifier (not a UUID). The `payload.summary` stored in `todo_sync_confirmations` provides this.

### Sync Direction Check
Only remove from HA if the sync direction is `"outbound"` or `"bidirectional"`. Don't touch inbound-only entities or items with `no-sync` label.

## Sources

### Primary (HIGH confidence)
- Codebase: `apps/web/src/domains/todo/todo-bridge.ts` — sync confirmation schema and outbound push pattern
- Codebase: `apps/web/src/lib/sync-outbound.ts` — event dispatcher, line 66 filter
- Codebase: `apps/web/src/domains/ha/ha-services.ts` — `removeTodoItem()` at line 393
- Codebase: `apps/web/src/pages/api/tasks/[id].ts` — DELETE handler with calendar cleanup
- Codebase: `integrations/home-assistant/custom_components/meitheal/llm_api.py` — LLM tool pattern

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps, all existing code
- Architecture: HIGH — following established patterns exactly
- Pitfalls: HIGH — codebase-specific, verified from source

**Research date:** 2026-03-16
**Valid until:** 2026-04-16 (stable internal patterns)
