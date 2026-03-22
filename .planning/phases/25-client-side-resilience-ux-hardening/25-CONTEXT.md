# Phase 25: Client-Side Resilience & UX Hardening - Context

**Gathered:** 2026-03-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Harden all client-side code paths for memory safety, click reliability, crash protection, and Astro-native lifecycle compliance. This phase does NOT add features — it makes every existing interaction rock-solid for production release.

Five pillars:
1. **UI/UX Improvements** — polish visual consistency, accessibility, and interaction feedback
2. **Click Handler Hardening** — eliminate double-submissions, ghost clicks, and unscoped listeners
3. **Astro-Native Compliance** — migrate remaining raw `addEventListener` to `pageLifecycle.on()`, ensure all scripts respect Astro navigation lifecycle
4. **Memory Optimization** — clean up `setInterval` without `clearInterval`, orphaned DOM references, unbounded innerHTML growth
5. **Crash Protection** — replace empty `catch {}` with logged fallbacks, add error boundaries for API failures, protect against null references in dynamic UI rendering

</domain>

<decisions>
## Implementation Decisions

### Click Handler Hardening
- All interactive elements inside dynamically-rendered lists MUST use event delegation on the parent (single listener) rather than per-row binds
- Double-submit prevention via AbortController is the canonical pattern (per docs/kcs/client-side-patterns.md)
- `pageLifecycle.on()` is mandatory for all new event bindings — raw `addEventListener` without signal is a blocking review fail

### Astro-Native Compliance
- Target files with raw `addEventListener` lacking signal/lifecycle cleanup:
  - `GoalsTab.astro` — 6 raw listeners (no signal)
  - `Layout.astro` — 8 raw listeners (document-level, intentionally global — review each)
  - `InlineDatePicker.ts` — uses own `listenerOpts(signal)` (OK, verify coverage)
  - `SettingsIntegrations.astro` — 1 raw listener
  - `ingress-state-persistence.ts` — 4 raw listeners (global persistence — may be intentional)
- Decision: Layout.astro document-level listeners (astro:page-load, beforeunload, pageshow) are OK as globals. GoalsTab and SettingsIntegrations need migration to pageLifecycle.

### Memory Optimization
- 15 `setInterval` calls found — audit each for cleanup:
  - `middleware.ts` rate-limit cleanup — OK (server-side, lives forever)
  - `page-lifecycle.ts` — internal cleanup interval — OK (self-managing)
  - `PomodoroTimer.astro` — needs verification of clearInterval on unmount
  - `layout-controller.ts` + `SidebarFooter.astro` — duplicate health check intervals! Consolidate to one.
  - `ha-connection.ts` — 2 intervals (reconnect check + heartbeat) — verify cleanup on disconnect
  - `grocy-bridge.ts` — timer with cleanup — OK
  - `sync-engine.ts` — periodic sync — verify stop path
  - `sw-register.ts` — update check interval — verify lifecycle
  - `pomodoro-service.ts` — timer interval — verify cleanup

### Crash Protection
- 9 empty `catch {}` blocks found — each needs at minimum `console.warn()` or structured logger call:
  - `CardCustomizer.astro:189`
  - `task-modal-controller.ts:449, 1182`
  - `NewTaskModal.astro:887, 990, 1194`
  - `SidebarHierarchyTree.astro:1054, 1082, 1533`
- innerHTML assignments (39 in task-modal-controller, 21+ in others) — audit for XSS, ensure user input is escaped
- All API fetch calls should have response.ok checks before parsing JSON

### UI/UX Improvements
- Consolidate duplicate health check UI (layout-controller + SidebarFooter)
- Ensure all buttons have loading/disabled states during async operations
- Progress indicators for long-running operations (sync, API calls)
- Focus management: return focus to trigger element after modal close
- Keyboard navigation: ensure all interactive elements are reachable via Tab

</decisions>

<specifics>
## Specific Hotspots (from codebase audit)

### High-Priority Files (by event listener count)
| File | addEventListener count | Status |
|------|----------------------|--------|
| `timeline-controller.ts` | 61 | Uses pageLifecycle ✅ |
| `task-modal-controller.ts` | 54 | Uses pageLifecycle ✅ |
| `NewTaskModal.astro` | 26 | Mixed — needs audit |
| `table-controller.ts` | 21 | Uses pageLifecycle ✅ |
| `SidebarHierarchyTree.astro` | 20 | Needs audit |
| `FilterToolbar.astro` | 19 | Needs audit |
| `kanban-controller.ts` | 15 | Uses pageLifecycle ✅ |

### innerHTML Usage (XSS risk)
| File | innerHTML count |
|------|----------------|
| `task-modal-controller.ts` | 39 |
| `settings-integrations-n8n-controller.ts` | 21 |
| `StrategicEvaluator.astro` | 12 |
| `SettingsGeneral.astro` | 10 |
| `modal-related-links.ts` | 7 |
| `settings-integrations-sync-controller.ts` | 6 |
| `settings-integrations-ha-controller.ts` | 6 |

### Duplicate Patterns to Consolidate
1. Health check interval — `layout-controller.ts` AND `SidebarFooter.astro` both run 30s intervals
2. Toast creation — `toast.ts` has `showToast`, `showRetryToast`, `showTaskCreatedToast` but some callers still inline toast DOM manipulation
3. Fetch error handling — inconsistent patterns across controllers (some throw, some return null, some swallow)

</specifics>

<deferred>
## Deferred Ideas

None — this phase is self-contained optimization work. New features belong in other phases.

</deferred>

---

*Phase: 25-client-side-resilience-ux-hardening*
*Context gathered: 2026-03-22*
