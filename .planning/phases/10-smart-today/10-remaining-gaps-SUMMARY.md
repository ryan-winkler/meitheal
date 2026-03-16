---
phase: 10-smart-today
plan: remaining-gaps
subsystem: apps/web (today page)
tags: [today, habits, calendar, recurrence, context-grouping, migration]
dependency_graph:
  requires: [task-repository, template-repository, feature-flags, ha-calendar-adapter]
  provides: [habits-on-today, calendar-events-display, context-grouping, recurrence-management]
  affects: [today.astro, today-controller.ts]
tech_stack:
  added: []
  patterns: [server-side-data-fetch, client-hydration, event-delegation, optimistic-ui]
key_files:
  created:
    - tests/e2e/today-page.spec.ts
    - .planning/phases/10-smart-today/10-RESEARCH-remaining-gaps.md
  modified:
    - apps/web/src/pages/today.astro
    - apps/web/src/lib/today-controller.ts
decisions:
  - "Used TemplateRepository (not habit-service.ts) for habits backend"
  - "Client-hydrate calendar events to avoid blocking SSR"
  - "Context grouping threshold set to 2+ distinct contexts"
  - "2-month lookahead for recurrence cleanup (per user request)"
  - "Recurrence cancel prompts cascade to all future occurrences"
metrics:
  duration: "~45m"
  completed: "2026-03-16T16:55:00Z"
  tasks_completed: 3
  files_changed: 4
---

# Phase 10 Remaining Gaps: Final 8 Gaps Summary

JWT auth with refresh rotation — Actually: Server-side habits data + client-hydrated calendar events + migration/recurrence management

**One-liner:** Implemented 8 remaining gaps (G27-G29, G38-G42) completing all 42 Smart Today Maturation items with habits section, calendar events, context grouping, migration prompt, and recurrence management.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Implement G27-G29, G38-G42 | `9bd7e61` | today.astro, today-controller.ts |
| 2 | Add Today page E2E tests | `ded264e` | today-page.spec.ts |
| 3 | Add phase research docs | `85e5c2c` | 10-RESEARCH-remaining-gaps.md |

## Implementation Details

### G38: Habits Section
- Server-side: `TemplateRepository.getHabitsWithStats()` in today.astro frontmatter
- Feature-gated via `isFeatureEnabled("habits")`
- Habit cards: icon + name + 🔥streak + total completions + complete button
- `setupHabitsSection()` handles click-to-complete with optimistic UI
- POST `/api/habits { action: "complete" }`

### G39: Save as Habit
- `saveTaskAsHabit(taskId, container)` exported from today-controller.ts
- POST `/api/habits { action: "create", taskId }`

### G27: Daily Migration Prompt
- Morning-only (before noon) check + localStorage dismiss persistence
- Banner with "Triage Now" (scrolls to Carried Forward) + "Dismiss"
- `MIGRATION_PROMPT_KEY` constant for localStorage

### G28: Calendar Events (HA Integration)
- Client-hydrated — fetches `/api/ha/calendars` then `/api/ha/events`
- Multi-calendar support with calendar name display
- Graceful degradation when HA not connected
- Events sorted by start time, time/all-day display

### G29: Context Grouping
- Auto-groups Due Today tasks by `@`-prefix labels
- Only activates when 2+ distinct contexts exist
- Context icons: 🏠 home, 💼 work, 🏃 errands, 👤 personal, 💪 health

### G40/G41: Recurrence Management
- `handleRecurrencePostComplete(taskId)` checks recurrence status
- End-of-recurrence prompts to continue
- Cancel cascades to all future occurrences via confirmDialog

### G42: 2-Month Lookahead + Cleanup
- `cancelRecurrence(taskId)` removes recurrence rule + future occurrences
- Cleanup deletes all pending (non-completed) future occurrences

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Astro JSX type annotation error**
- Found during: Task 1 (implementation)
- Issue: Type annotation in `.map()` callback caused JSX parse error
- Fix: Changed `(tmpl: any) => { return (...) }` to implicit return `=> (...)`
- Commit: `9bd7e61`

**2. [Rule 1 - Bug] Fixed confirmDialog signature**
- Found during: Task 1 (implementation)
- Issue: `confirmDialog` called with positional args instead of object
- Fix: Changed to `confirmDialog({ title, message })` pattern
- Commit: `9bd7e61`

## Verification

| Check | Result |
|-------|--------|
| `astro check` | ✅ Exit code 0 |
| `pnpm check` | ✅ Build complete, exit code 0 |
| `pnpm test` | ✅ 319 passed, 114 skipped, 0 failures |
| Anti-pattern scan | ✅ 0 TODOs, 0 stubs, 0 placeholders |

## Self-Check: PASSED

All created files verified to exist:
- ✅ `tests/e2e/today-page.spec.ts`
- ✅ `.planning/phases/10-smart-today/10-RESEARCH-remaining-gaps.md`
- ✅ `.planning/phases/10-smart-today/10-VERIFICATION.md`

All commits verified:
- ✅ `9bd7e61` — feat: G27-G29, G38-G42
- ✅ `ded264e` — test: Today page E2E spec
- ✅ `85e5c2c` — docs: phase research
