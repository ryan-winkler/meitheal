# Panel Round 2 — ADHD / Productivity Specialists

**Phase:** 25 — Client-Side Resilience & UX Hardening
**Iteration:** 01
**Objective:** Improve cognitive load, reduce friction, and ensure capture-triage-follow-through patterns are resilient

---

## 1. Workflow Coach

**Recommendation:** Standardize error feedback across all fetch() callsites into a single `fetchWithFeedback(url, opts)` utility that: (1) shows a spinner toast for operations >500ms, (2) shows success/error toasts automatically, (3) returns typed `{ok, data, error}` discriminated union. This eliminates the cognitive burden of remembering to add error handling per controller.

**Success Criterion:** At least 5 controllers migrated to `fetchWithFeedback`. No naked `fetch()` in new code without explicit opt-out comment.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 3 |
| Risk | 2 |

**Decision:** ✅ Accept — impact(4) >= effort(3), directly reduces context-switch cost when adding new API integrations.

---

## 2. Execution Coach

**Recommendation:** Add keyboard shortcut tooltips to all major action buttons (New Task: `N`, Search: `/`, Quick Add: `Q`) by reading the existing `keyboard-shortcuts.ts` registry and rendering tooltip overlays. This surfaces hidden affordances that ADHD users discover by accident or never find.

**Success Criterion:** Hovering any button with a registered shortcut shows a tooltip with the key binding. Can be verified visually in browser.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 3 |
| Risk | 1 |

**Decision:** ✅ Accept — impact(3) >= effort(3), improves discoverability without adding new shortcuts.

---

## 3. Knowledge Coach

**Recommendation:** Add a standardized error state component (`ErrorState.astro`) that shows: (1) what went wrong in plain English, (2) a retry button, and (3) a link to the relevant docs page. Use this component in all list views (tasks, labels, habits, pillars) when API fetches fail, replacing the current mix of empty states and silent failures.

**Success Criterion:** All list-fetching views render `ErrorState` on API failure instead of showing empty content. Can be verified by disconnecting from network and navigating.

| Metric | Score |
|--------|-------|
| Impact | 4 |
| Effort | 3 |
| Risk | 1 |

**Decision:** ✅ Accept — impact(4) >= effort(3), directly improves self-service debugging and reduces support tickets.

---

## 4. Focus Optimizer

**Recommendation:** Ensure `PomodoroTimer.astro` cleans up its `setInterval` (line 388) when the timer component is removed from DOM or the page navigates away. Currently, if the user starts a timer and navigates to another page, the interval may continue ticking silently, consuming CPU and potentially showing stale notifications.

**Success Criterion:** Navigate away from the Pomodoro page mid-timer, return, and confirm: (1) no duplicate timers running, (2) timer state restored from last known position, (3) `performance.getEntries()` shows no leaked timers.

| Metric | Score |
|--------|-------|
| Impact | 3 |
| Effort | 2 |
| Risk | 1 |

**Decision:** ✅ Accept — impact(3) >= effort(2), prevents invisible resource drain.

---

## 5. Automation Coach

**Recommendation:** Create a `setManagedInterval(fn, ms, signal)` utility in `page-lifecycle.ts` (or extend the existing managed-listeners module) that automatically clears the interval when the AbortSignal fires. Migrate the 5 highest-risk intervals to use it: `layout-controller.ts`, `SidebarFooter.astro`, `PomodoroTimer.astro`, `ha-connection.ts` heartbeat, and `sync-engine.ts`.

**Success Criterion:** `rg 'setInterval\(' src/ -g '*.ts' -g '*.astro'` shows all page-scoped intervals using `setManagedInterval`. Only server-side or truly-global intervals (middleware, page-lifecycle internal) use raw `setInterval`.

| Metric | Score |
|--------|-------|
| Impact | 5 |
| Effort | 2 |
| Risk | 2 |

**Decision:** ✅ Accept — impact(5) >= effort(2), foundational utility that prevents all future interval leaks.

---

## Summary

| # | Persona | Decision | Impact | Effort | Risk |
|---|---------|----------|--------|--------|------|
| 1 | Workflow Coach | ✅ Accept | 4 | 3 | 2 |
| 2 | Execution Coach | ✅ Accept | 3 | 3 | 1 |
| 3 | Knowledge Coach | ✅ Accept | 4 | 3 | 1 |
| 4 | Focus Optimizer | ✅ Accept | 3 | 2 | 1 |
| 5 | Automation Coach | ✅ Accept | 5 | 2 | 2 |

**All 5 accepted. Key capture/triage improvement: ErrorState component (#3) + fetchWithFeedback (#1) together create a systematic capture-triage-feedback loop for all API interactions.**
