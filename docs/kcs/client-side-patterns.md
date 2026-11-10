---
type: "Guide"
title: "Client-Side Patterns & HMR Gotchas"
description: "Implement client controls that work with the application lifecycle."
---

# Client-Side Patterns & HMR Gotchas

> **Last updated:** 2026-11-09 | **Domain:** `apps/web/src/`

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

## Shared navigation and theme checks

Page-shell section labels use `--accent-text` on populated and empty pages. Run `e2e/theme-accent-focus.spec.ts` to check those labels with a surface-matching custom accent in Light and Dark, and to verify keyboard focus after navigation.

The sidebar area button controls the project list named by its `aria-controls` attribute. Keep the action buttons alongside the disclosure. Update `aria-expanded` and the list's `inert` state together so collapsed project links stay out of keyboard navigation. Sidebar area actions are delegated to the persisted navigation. Dispose that listener on hot reload so Astro page swaps can keep using the existing navigation element.

Use `--accent-text` for accent-colored labels on surfaces and keep the accent fill token for backgrounds. Keep the CSS and Tailwind text color channels aligned across themes. Use `--floating-action-bottom` for the Dashboard, Settings, and Habits scroll-to-top buttons. The mobile offset includes the tab bar and device safe area. Keyboard shortcut help is available through **Settings → Personal → Keyboard Shortcuts**. Turn off **Enable letter, number and symbol shortcuts on this device** to disable shortcuts such as `/`, `?`, and the numbered Tasks views. The choice is stored in this browser. Tab, arrow keys, Enter, Space, and shortcuts such as Ctrl or Cmd + K still work.

Run `pnpm --filter @meitheal/tests test e2e/shared-shell-ux.spec.ts` against a disposable Meitheal instance. The check samples desktop and mobile in light and dark themes. It exercises Dashboard, Tasks, and the Settings navigation, rule labels, integration badges, and protocol links. The keyboard check creates and removes a synthetic sidebar area and project.

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

## User content in HTML and page data

Use the server sanitizer for rich text accepted by the task API. Use text nodes for plain text and keep render-time protection for data already in SQLite. The sanitizer dependency requires Node.js 22.12 or later.

When Astro embeds JSON in a script element, use `serializeForScript` from `lib/safe-html.ts` and read the element's `textContent` with `JSON.parse`. This preserves values such as labels while preventing them from closing the script element. Apply it even when values already passed write-time validation, since storage and HTML have different boundaries. Escape user-defined labels and identifiers before interpolating them into the Kanban lane markup.

For a regression check, run `pnpm --filter @meitheal/tests test e2e/sanitize.spec.ts e2e/timeline-bootstrap.spec.ts` with `E2E_BASE_URL` pointed at a disposable Meitheal instance and SQLite database. The timeline check creates and deletes a synthetic task.

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

## Embedded navigation and generated controls

Inside the same-origin Home Assistant panel, Meitheal keeps its current route in the outer address's `meitheal` query parameter. Opening that bookmark recreates the iframe at the saved route. Native page navigation and ticket history update the value. Direct ingress tabs keep their normal page URL.

Controls appended by client code outside an Astro component need global CSS selectors. Check generated menus with real pointer and keyboard input near the viewport edge. Moving focus into a menu should keep its options reachable.
