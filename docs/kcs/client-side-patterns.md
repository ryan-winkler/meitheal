# Client-Side Patterns & HMR Gotchas

> **Last updated:** 2026-03-22 | **Domain:** `apps/web/src/`

## Overview

Meitheal's frontend runs entirely as Astro SSR with client-side JavaScript in `<script>` blocks. This creates specific patterns and pitfalls around event listener management, especially during development with Vite's Hot Module Replacement (HMR).

## Critical Pattern: AbortSignal for Listener Cleanup

Astro's `pageLifecycle.onPageLoad(signal)` provides an `AbortSignal` that aborts on page navigation. **Every `addEventListener` call must pass `{ signal }` to prevent listener accumulation.**

```ts
import { pageLifecycle } from "@lib/page-lifecycle"
pageLifecycle.onPageLoad((signal) => {
  const el = document.getElementById("my-element")
  // ✅ CORRECT: passes signal for auto-cleanup
  el?.addEventListener("click", handler, { signal })

  // ❌ WRONG: leaks across navigations
  el?.addEventListener("click", handler)
})
```

## Critical Pattern: HMR Listener Accumulation

Vite HMR re-evaluates `<script>` blocks without aborting the previous Astro lifecycle signal. This means `pageLifecycle.onPageLoad` fires again with a **new** signal, registering a **second** handler on the same DOM element.

### Solutions (pick one per case)

| Approach | When to use |
|----------|-------------|
| `cloneNode(true)` + `replaceWith()` | Forms — strips ALL listeners from the element |
| Window-scoped guard flag | Cross-scope state — `(window as any).__flagName` |
| Module-scoped guard | **Does NOT work** — each HMR eval creates a new scope |

### Example: Clone-Form Pattern (NewTaskModal.astro)

```ts
if (form) {
  const freshForm = form.cloneNode(true) as HTMLFormElement
  form.replaceWith(freshForm)
  freshForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    // ...handler
  }, { signal })
}
```

## Toast System

Located at `apps/web/src/lib/toast.ts`.

| Function | Purpose | Auto-dismiss |
|----------|---------|-------------|
| `showToast(msg, type)` | General notification | 3s success, 5s error |
| `showUndoToast(msg, onUndo)` | Action with undo button | 5s |
| `showRetryToast(msg, onRetry)` | Action with retry button | 8s |
| `showTaskCreatedToast(key, id, title)` | Task created with clickable ticket key | 4s |

### Toast Conventions

- Max 5 visible toasts; oldest evicted when exceeded
- All toasts must have `role="alert"`, `aria-live`, and dismiss button
- i18n strings loaded from `window.mI18n` (set by `Layout.astro`)
- `showTaskCreatedToast` renders clickable `MTH-XX` that calls `window.openTaskDetail(id)`

## Task API Response Contract

```
POST /api/tasks → { id, ticket_key, title, status, ... }  // FLAT
GET  /api/tasks → { tasks: [...], total: N }               // WRAPPED
GET  /api/tasks/[id] → { id, ticket_key, ... }             // FLAT
```

> ⚠️ **Never** access `response.task.id` from POST — use `response.id` directly.

## Custom Fields Rendering

Shopping items store complex data in `custom_fields`:
```json
{ "quantity": 2, "category": "dairy", "items": [{"name": "Milk", "qty": 1}] }
```

When rendering custom fields on kanban cards:
1. Check `task_kind === "shopping_item"` → render compact summary chips
2. For generic custom fields → filter with `typeof v !== "object"` before `String(v)`
3. Never call `String()` on arrays or objects — produces `[object Object]`

## Global Window Properties (Cleanup Required)

These are set during modal lifecycle and must be cleaned up on signal abort:

| Property | Purpose |
|----------|---------|
| `window.__ntFormSubmitting` | Double-submit guard |
| `window._removeNTCItem` | Checklist item removal |
| `window.__ntShoppingItems` | Shopping items state |
| `window.__meitheal_users` | User list cache |
| `window.__ntDatePickers` | Date picker instances |
| `window.openNewTaskModal` | Modal open function |
| `window.openTaskDetail` | Detail modal open function |
