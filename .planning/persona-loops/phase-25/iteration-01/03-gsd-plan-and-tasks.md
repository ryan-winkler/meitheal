# GSD Plan & Tasks — Phase 25 Iteration 01

**Synthesized from:** Frontier Panel (5 accepted) + ADHD Panel (5 accepted) = 10 tasks
**Priority order:** Foundation utilities first, then migrations, then polish

---

## Wave 1: Foundation Utilities (2 tasks)

### T1: Create `setManagedInterval` utility
**Source:** ADHD Panel #5 (Automation Coach)
**Impact:** 5 | **Effort:** 2 | **Risk:** 2
**GSD Command:** Execute directly

Add `setManagedInterval(fn, ms, signal): number` to `apps/web/src/lib/page-lifecycle.ts` (or `managed-listeners.ts`). Clears interval when AbortSignal fires. This is the foundation for all subsequent interval cleanup work.

### T2: Create `withAsyncButton` wrapper
**Source:** Frontier Panel #5 (Product Architect)
**Impact:** 4 | **Effort:** 3 | **Risk:** 2
**GSD Command:** Execute directly

Add `withAsyncButton(btn, asyncFn)` to a new `apps/web/src/lib/async-button.ts`. Sets disabled + spinner class on click, restores on completion/error, prevents double-click via AbortController guard.

---

## Wave 2: Crash Protection (2 tasks)

### T3: Eliminate all empty `catch {}` blocks
**Source:** Frontier Panel #2 (OSS Integrations)
**Impact:** 4 | **Effort:** 2 | **Risk:** 1
**GSD Command:** Execute directly

Replace 9 empty catches with `console.warn('component:operation', error)` or structured logging. Target files:
- `CardCustomizer.astro:189`
- `task-modal-controller.ts:449, 1182`
- `NewTaskModal.astro:887, 990, 1194`
- `SidebarHierarchyTree.astro:1054, 1082, 1533`

### T4: innerHTML XSS audit for top 3 hotspots
**Source:** Frontier Panel #4 (Security Engineer)
**Impact:** 5 | **Effort:** 3 | **Risk:** 3
**GSD Command:** Execute directly

Audit `task-modal-controller.ts` (39), `settings-integrations-n8n-controller.ts` (21), `StrategicEvaluator.astro` (12). Convert user-controlled strings to `textContent`/`createTextNode`.

---

## Wave 3: Lifecycle Migrations (3 tasks)

### T5: Consolidate duplicate health-check intervals
**Source:** Frontier Panel #1 (Platform Architect)
**Impact:** 4 | **Effort:** 2 | **Risk:** 2
**GSD Command:** Execute directly

Create `health-monitor.ts` with single 30s interval. Both `layout-controller.ts` and `SidebarFooter.astro` subscribe via event.

### T6: Migrate GoalsTab.astro to pageLifecycle
**Source:** Frontier Panel #3 (Reliability Engineer)
**Impact:** 4 | **Effort:** 2 | **Risk:** 2
**GSD Command:** Execute directly

Replace 6 raw `addEventListener` calls with `pageLifecycle.on()`.

### T7: Migrate PomodoroTimer interval to setManagedInterval
**Source:** ADHD Panel #4 (Focus Optimizer)
**Impact:** 3 | **Effort:** 2 | **Risk:** 1
**GSD Command:** Execute directly

Replace raw `setInterval` at line 388 with `setManagedInterval` from T1.

---

## Wave 4: UX Polish (3 tasks)

### T8: Create ErrorState.astro component
**Source:** ADHD Panel #3 (Knowledge Coach)
**Impact:** 4 | **Effort:** 3 | **Risk:** 1
**GSD Command:** Execute directly

Reusable error state with message, retry button, and optional docs link. Deploy to labels, habits, pillars list views.

### T9: Create fetchWithFeedback utility
**Source:** ADHD Panel #1 (Workflow Coach)
**Impact:** 4 | **Effort:** 3 | **Risk:** 2
**GSD Command:** Execute directly

Unified fetch wrapper with spinner toast, error toast, typed return. Migrate 5 highest-traffic controllers.

### T10: Keyboard shortcut tooltips on action buttons
**Source:** ADHD Panel #2 (Execution Coach)
**Impact:** 3 | **Effort:** 3 | **Risk:** 1
**GSD Command:** Execute directly

Render shortcut hints on hover for buttons with registered keyboard shortcuts.

---

## Execution Order

```
T1 (setManagedInterval) → T7 (Pomodoro migration) → T5 (health consolidation)
T2 (withAsyncButton) — parallel with T1
T3 (empty catches) — parallel with T1
T4 (innerHTML audit) — after T3
T6 (GoalsTab lifecycle) — parallel with T5
T8 (ErrorState) → T9 (fetchWithFeedback) — after T3
T10 (keyboard tooltips) — last, polish
```
