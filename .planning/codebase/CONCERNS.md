# Codebase Concerns

> Last mapped: 2026-03-15 — Post design-token-migration + PGD audit

## Critical: Kanban Script Monolith

**File:** `apps/web/src/pages/kanban.astro` (3,318 lines total, 1,970 lines inline `<script>`)
- Defeats Astro's island architecture — all JS loads for every visitor
- Makes HMR unpredictable, prevents tree-shaking
- Contains: drag-and-drop, quick actions (`_qa` popover), filter/swimlane logic, inline-add, context menu
- **Fix:** Extract to `apps/web/src/lib/kanban-controller.ts` (PGD-01)
- **Priority:** P0 — largest remaining tech debt

## Medium: Other Large Files

| File | Lines | Concern |
|------|-------|---------|
| `settings-controller.ts` | 3,206 | Already extracted (PGD-04 ✅), but very large |
| `task-modal-controller.ts` | 2,353 | Large modal logic, works but hard to maintain |
| `table-controller.ts` | 1,336 | Growing but reasonable, recently got summary rows |
| `tasks.astro` | 814 | Has some inline script that could use extraction |

## Medium: Missing Functionality

**Smart Today (SMT):**
- Today page has overdue section but no "Suggested" tasks (high-priority, soon-due)
- No one-click "add to today" from other views
- No daily summary stats (completed/remaining/overdue counts)

**Version Tooling (VER):**
- No `check-version-sync.mjs` script
- No `bump-version.mjs` script
- No CI version validation

## Low: Previously Resolved ✅

- ~~Design Token Violations~~ — migrated to `var(--type-*)`, `var(--prio-*)` tokens
- ~~Accessibility Gaps~~ — `_qa` popover has ARIA roles, keyboard nav, focus management
- ~~Performance Listeners~~ — consolidated to single `_qa` click/keydown listener
- ~~UX Gaps~~ — optimistic updates, loading skeletons, exit animations, swatch indicators
