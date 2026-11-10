---
type: "Guide"
title: "Memory-Safe Event Listener Patterns"
description: "Manage browser event listeners and clean up their resources."
---

# Memory-Safe Event Listener Patterns

> KCS article — 3 patterns, 3 examples, 3 anti-patterns for Meitheal client-side code.

## Why This Matters

Meitheal runs inside Home Assistant's ingress iframe with Astro view transitions.
Every page navigation fires `astro:before-swap`, which replaces the DOM — but
**JavaScript module state and event listeners persist** unless explicitly cleaned up.
Without cleanup, listeners accumulate on HMR re-evaluation and view transitions,
causing memory leaks, duplicate handlers, and degraded performance.

---

## Pattern 1: `managedListeners()` (Preferred for complex controllers)

Use when a controller registers **many** listeners on different elements.

```typescript
import { managedListeners } from "@lib/managed-listeners"

export function initMyController(signal: AbortSignal) {
  const ml = managedListeners(signal)

  ml.add(document, "click", handleClick)
  ml.add(window, "resize", handleResize)
  ml.add(form, "submit", handleSubmit)
  // All 3 listeners auto-removed when signal aborts
}
```

**When to use:** Controllers with 3+ listeners, drag-and-drop, scroll handlers.

---

## Pattern 2: `pageLifecycle.on(signal)` (Preferred for page-level setup)

Use for page-load initialization where the framework provides the signal.

```typescript
import { pageLifecycle } from "@lib/page-lifecycle"

pageLifecycle.onPageLoad((signal) => {
  document.addEventListener("keydown", handleShortcuts, { signal })
  
  const btn = document.getElementById("my-btn")
  btn?.addEventListener("click", handleClick, { signal })
  // Both listeners cleaned up on next navigation
})
```

**When to use:** Page scripts, `<script>` blocks in `.astro` files.

---

## Pattern 3: `AbortController` with `{ signal }` (Lowest-level)

Use when you need manual control over listener lifecycle.

```typescript
const ac = new AbortController()

element.addEventListener("click", handler, { signal: ac.signal })
element.addEventListener("mouseover", hover, { signal: ac.signal })

// Later, when done:
ac.abort() // removes both listeners
```

**When to use:** Modal open/close cycles, temporary listeners, fetch cancellation.

---

## Anti-Patterns ❌

### 1. Bare `addEventListener` without signal

```typescript
// ❌ NEVER — leaks on every HMR/navigation
element.addEventListener("click", handler)
```

### 2. Module-scoped guard flags

```typescript
// ❌ FAILS — HMR re-evaluates modules, creating new scopes
let initialized = false
if (!initialized) { /* ... */ initialized = true }
```

### 3. `removeEventListener` without matching reference

```typescript
// ❌ FRAGILE — arrow functions create new references
element.addEventListener("click", () => doThing())
element.removeEventListener("click", () => doThing()) // doesn't remove!
```

---

## Decision Matrix

| Scenario | Pattern | Why |
|----------|---------|-----|
| Page controller with 3+ listeners | `managedListeners()` | Batch cleanup, readable |
| Page-load init in `.astro` `<script>` | `pageLifecycle.on(signal)` | Framework-managed signal |
| Modal/overlay temporary listeners | `AbortController` | Manual lifecycle control |
| `fetch()` calls | `{ signal }` from page signal | Cancel on navigation |
| Global singleton (toast, error handler) | `window`-scoped guard | Survives HMR correctly |

---

*Created: 2026-03-23 · Phase 29 T3*
