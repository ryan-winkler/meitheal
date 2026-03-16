# Phase 10: Settings Hardening - Research

**Researched:** 2026-03-16
**Domain:** Client-side memory safety, DOM lifecycle, XSS prevention, UI/UX polish
**Confidence:** HIGH

## Summary

The settings subsystem (9,708 LoC across 14 controllers + 10 components) has a critical memory lifecycle gap: **40+ event listeners** are registered via raw `addEventListener()` in sub-controllers without any cleanup mechanism, while the shell controller correctly uses `pageLifecycle.on()`. Every hash-navigation re-enters `init*()` functions, stacking duplicate listeners on the same DOM elements. After 10+ navigations, a single button click fires 10+ handlers — causing duplicate saves, race conditions, and potential crashes.

Additionally, **zero `AbortController`** instances are used for `fetch()` calls. Concurrent/abandoned requests can resolve into stale DOM, and there's no way to cancel in-flight requests when navigating away. **12+ `innerHTML` assignments** interpolate server-sourced data (error messages, workflow names, entity IDs) without escaping — a stored XSS vector if any upstream API returns malicious content.

**Primary recommendation:** Migrate all raw `addEventListener` calls to `pageLifecycle.on()` (the pattern already proven in `settings-shell-controller.ts`), wire AbortController signals into fetch calls, and create an `escapeHtml()` utility for all innerHTML interpolations.

## Standard Stack

### Core (Already In-Use)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `page-lifecycle.ts` | Custom | AbortController lifecycle for event listeners | Already proven in settings-shell-controller.ts — 15+ listeners, 2 MutationObservers clean up automatically |
| `@lib/toast.ts` | Custom | User feedback for async operations | Already used by 6 controllers for save/error feedback |
| `@lib/safe-fetch.ts` | Custom | Fetch wrapper with error normalization | Already exists but not used in settings controllers |

### Supporting (To Create)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@lib/safe-html.ts` | NEW | HTML escaping for innerHTML | Any innerHTML with interpolated data |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `escapeHtml()` utility | `textContent` only | textContent is safest but can't render HTML structure (bold, spans) needed for status indicators |
| `pageLifecycle.on()` | Manual AbortController per init | Unnecessary — pageLifecycle already implements this pattern correctly |

## Architecture Patterns

### Recommended: pageLifecycle.on() for ALL listeners

The `settings-shell-controller.ts` already demonstrates the correct pattern:

```typescript
// Source: apps/web/src/lib/settings-shell-controller.ts (verified in codebase)
import { pageLifecycle } from "@lib/page-lifecycle"

// Listeners auto-cleanup on page navigation
pageLifecycle.on(button, "click", () => { /* handler */ })
pageLifecycle.on(window, "hashchange", () => { /* handler */ })

// For MutationObservers, use signal abort callback
pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
  signal: pageLifecycle.signal
})
```

### Anti-Pattern: Raw addEventListener in init functions

```typescript
// CURRENT (BAD) — in 8 sub-controllers
export function initThemeSettings() {
  document.getElementById("save-theme")?.addEventListener("click", async () => {
    // This listener STACKS on every hash navigation
  })
}
```

### Recommended: Signal-Aware Fetch

```typescript
// For fetch() calls that should be cancelled on navigation
const res = await fetch("/api/settings", { signal: pageLifecycle.signal })
if (pageLifecycle.signal.aborted) return // Guard before DOM update
```

### Anti-Patterns to Avoid
- **Raw addEventListener in init functions:** Stacks listeners on every call without cleanup
- **innerHTML with template literals:** XSS vector when interpolating server data
- **setTimeout without stored handles:** Can fire after navigation, updating stale DOM
- **window.location.reload() for state updates:** Disrupts HA ingress iframe context

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event listener lifecycle | Manual removeEventListener tracking | `pageLifecycle.on()` | Already exists, proven, auto-cleans |
| Fetch abort | Manual AbortController per function | `pageLifecycle.signal` | Tied to page lifecycle, auto-aborts |
| HTML escaping | Inline replace patterns | Shared `escapeHtml()` utility | Consistent, testable, one fix point |
| Button busy state | Per-button disabled logic | Shared `withBusyButton()` helper | Reduces boilerplate across 15+ save buttons |

## Common Pitfalls

### Pitfall 1: Listener Stacking on Hash Navigation
**What goes wrong:** `astro:page-load` fires on every navigation. Settings uses hash navigation (`#personal-settings` → `#integrations-settings`). Each navigation re-initializes controllers, stacking duplicate listeners.
**Why it happens:** Raw `addEventListener()` doesn't replace existing listeners — it adds new ones alongside.
**How to avoid:** Use `pageLifecycle.on()` which auto-aborts previous listeners on navigation.
**Warning signs:** Console shows duplicate log messages on button click after navigating between settings sections.

### Pitfall 2: Stale Fetch Responses Updating Wrong DOM
**What goes wrong:** User navigates away from integrations while n8n diagnostics fetch is in-flight. Response arrives and updates DOM elements that may now belong to a different section or be removed.
**Why it happens:** No `AbortController` on fetch, no signal.aborted guard before DOM update.
**How to avoid:** Pass `pageLifecycle.signal` to fetch, guard DOM updates with `signal.aborted` check.
**Warning signs:** Status indicators briefly flicker to wrong state after navigation.

### Pitfall 3: XSS via innerHTML
**What goes wrong:** Server error messages, workflow names, or entity IDs containing `<script>` or event handlers are rendered via innerHTML.
**Why it happens:** Template literal interpolation in innerHTML doesn't auto-escape.
**How to avoid:** Use `escapeHtml()` wrapper for all interpolated values, or `textContent` where HTML structure isn't needed.
**Warning signs:** Any user-facing text that could originate from external APIs (Grocy version string, n8n workflow name, HA entity name).

### Pitfall 4: setTimeout Firing After Navigation
**What goes wrong:** A `setTimeout(() => window.location.reload(), 1000)` fires 1 second after user has already navigated away, causing an unexpected page reload.
**Why it happens:** setTimeout handles aren't stored or cleared on re-init.
**How to avoid:** Store handle, clear on re-init, guard callback with `signal.aborted`.
**Warning signs:** Random page reloads when user navigates quickly between settings sections.

### Pitfall 5: Double-Click on Destructive Actions
**What goes wrong:** User double-clicks "Purge Tasks" button, second click fires before first completes.
**Why it happens:** Button not disabled during async operation.
**How to avoid:** Shared `withBusyButton()` pattern that disables button and shows "Processing..." text.
**Warning signs:** Console network tab shows duplicate POST requests.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Raw addEventListener | `pageLifecycle.on()` with AbortController | Already in codebase (2026-03-15) | Auto-cleanup, zero memory leaks |
| innerHTML with template literals | textContent + escapeHtml() for rich content | Current best practice | XSS prevention |
| window.location.reload() | Reactive DOM updates + targeted re-fetch | Phase 08.2 (partial) | Better UX, HA ingress safe |

## Open Questions

1. **SettingsGeneral.astro / SettingsSystem.astro inline scripts**
   - These components have their own `<script>` blocks with listeners
   - They don't import `pageLifecycle` — need to verify if Astro's scoped script lifecycle handles cleanup
   - Recommendation: Migrate to `pageLifecycle.on()` if scripts persist across navigation

2. **SettingsSystem.astro remaining reloads**
   - 2 reloads remain (locale change + SW update). Locale change may legitimately require reload for server-rendered i18n.
   - Recommendation: Keep locale reload as documented exception, convert SW update to toast notification

## Sources

### Primary (HIGH confidence)
- `/withastro/docs` (Context7) — `astro:page-load` lifecycle, no built-in cleanup mechanism confirmed
- `apps/web/src/lib/page-lifecycle.ts` — existing AbortController lifecycle implementation (verified in codebase)
- `apps/web/src/lib/settings-shell-controller.ts` — proven pattern with 15+ listeners (verified in codebase)

### Secondary (MEDIUM confidence)
- MDN Web Docs — AbortController.signal with addEventListener `{ signal }` option — standard Web API
- OWASP XSS Prevention — innerHTML interpolation as injection vector

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — patterns already exist in codebase
- Architecture: HIGH — extending proven pageLifecycle pattern
- Pitfalls: HIGH — verified by grep audit of all 9,708 LoC
- UX improvements: MEDIUM — some items (loading states) need visual iteration

**Research date:** 2026-03-16
**Valid until:** 2026-04-16 (stable patterns, not library-version dependent)
