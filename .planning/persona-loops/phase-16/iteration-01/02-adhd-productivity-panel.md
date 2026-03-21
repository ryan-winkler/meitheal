# ADHD/Productivity Panel - Phase 16 Iteration 01

## Objective
Tasks Layout Redesign: Unify 4 task views under single /tasks page with hash-based view switching, Area/Space selector, composable filter row, and Customize panel

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Workflow Coach | Add keyboard shortcut `1-4` keys to switch between views (1=Kanban, 2=Table, 3=Calendar, 4=Timeline) when no input is focused. This eliminates mouse travel to the view tabs and matches power-user navigation patterns. Register shortcuts in the existing `SearchHub` keyboard handler to avoid conflicts. Success: Pressing `2` on the tasks page switches to Table view instantly. | 4 | 2 | 1 | Accept |
| Execution Coach | Default the active view to the last-used view from `localStorage` (already in the implementation plan). Additionally, remember the scroll position per view so returning to Kanban shows the same column position. Use `data-scroll-top` attribute on each view container. Success: Switch from Kanban (scrolled right to column 5) → Table → back to Kanban shows column 5 still visible. | 4 | 2 | 1 | Accept |
| Knowledge Coach | Add an accessible `aria-label` to each view tab button with the format "Switch to {View} view" and mark the active tab with `aria-selected="true"`. Add `role="tablist"` to the container and `role="tab"` to each button. This makes the view switcher screen-reader friendly. Success: NVDA/VoiceOver announces "Switch to Table view, tab 2 of 4, selected" when focused. | 3 | 1 | 1 | Accept |
| Focus Optimizer | Scope Phase 16.1 to ONLY view switching and redirects — do not touch FilterToolbar, Area selector, or Customize panel in this sub-phase. These are later sub-phases (16.2-16.4) with explicit dependency chains. Mixing them in 16.1 will create scope creep and context switching overhead. Success: Phase 16.1 PR touches only tasks.astro, view components, redirect pages, and view controller. No filter or customize changes. | 5 | 1 | 1 | Accept |
| Automation Coach | Create an E2E test helper function `switchToView(page, view)` that encapsulates the hash navigation + wait pattern. Reuse this in all tasks E2E tests rather than duplicating hash navigation logic across specs. Success: All tasks specs use `switchToView(page, "table")` instead of manual `page.goto` + hash manipulation. | 3 | 1 | 1 | Accept |

## Rejected or Deferred

- (none — all recommendations are actionable and low-effort)
