---
phase: 13-todo-outbound-delete
plan: 01
type: summary
status: complete
commit: 9e146e7
---

# Phase 13-01: Todo Outbound Delete Sync — Summary

**Status:** ✅ Complete
**Commit:** `9e146e7`
**Tests:** 319 passed, 0 failures
**Build:** Clean

## What Was Done

### Problem
Deleting a Meitheal task orphaned the corresponding HA todo list item. Only calendar cleanup existed — no todo cleanup.

### Solution

1. **`removeTaskFromTodoList()`** — New function in `todo-bridge.ts` that queries `todo_sync_confirmations`, calls `removeTodoItem()` for each linked HA entity, and cleans up confirmation rows.

2. **Outbound sync wiring** — `sync-outbound.ts` now handles `task.deleted` events, calling `removeTaskFromTodoList()` with `no-sync` label respected.

3. **DELETE handler** — `apps/web/src/pages/api/tasks/[id].ts` now does fire-and-forget todo cleanup alongside calendar cleanup.

4. **`RemoveFromTodoListTool`** — New LLM tool in `llm_api.py` that accepts `task_id` or `title`, resolves via search, and calls `coordinator.async_delete_task()` to trigger full cleanup. API prompt updated.

### Files Modified

| File | Change |
|------|--------|
| `apps/web/src/domains/todo/todo-bridge.ts` | +`removeTaskFromTodoList()` |
| `apps/web/src/domains/todo/index.ts` | +export |
| `apps/web/src/lib/sync-outbound.ts` | +`task.deleted` handler |
| `apps/web/src/pages/api/tasks/[id].ts` | +todo cleanup in DELETE |
| `integrations/home-assistant/custom_components/meitheal/llm_api.py` | +`RemoveFromTodoListTool` + prompt |

### Coverage

| Surface | Path |
|---------|------|
| MCP | `deleteTask` → REST → cleanup |
| LLM/AI | `RemoveFromTodoListTool` → coordinator → REST → cleanup |
| HA Voice | `MeithealDeleteTask` intent → coordinator → REST → cleanup |
| Outbound Sync | `task.deleted` event → `removeTaskFromTodoList()` |

## Verification

- `astro check` — exit 0 ✅
- `pnpm --filter @meitheal/web build` — clean ✅
- `pnpm --filter @meitheal/tests test` — 319 passed ✅
- Python syntax — valid ✅
- Tier 2 devcontainer testing — pending (Docker socket access)

## Deferred

- **Tier 2 round-trip test**: Verify actual HA todo item removal in devcontainer environment
- **Granular remove (keep Meitheal task)**: Currently `RemoveFromTodoListTool` deletes the task entirely. A future enhancement could add a dedicated `/api/tasks/{id}/todo-sync` DELETE endpoint to remove only from HA lists while keeping the Meitheal task.
