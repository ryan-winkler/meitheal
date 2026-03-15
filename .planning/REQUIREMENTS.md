# Core Feature Completion — Requirements (Revised)

**Project:** Meitheal Core Feature Completion Sprint
**Version:** v1.1 (revised after deep code audit — 2026-03-09)
**Date:** 2026-03-09

> [!IMPORTANT]
> Deep audit revealed ~60% of original Phase 1-3 requirements already exist as working UI.
> Requirements updated to reflect actual gaps only.

---

## Subtask Hierarchy UI (SUB)

> Existing: parent search, children list, parent link/unlink, kanban badges, Gantt tree
> Missing: table indent, "Add subtask" button, progress bar, hierarchy unification

- [ ] **SUB-01**: Table tree indent — child tasks indented under parent with expand/collapse toggles
- [ ] **SUB-02**: "Add subtask" button in task detail panel — opens inline quick-create form with parent_id auto-set
- [ ] **SUB-03**: Subtask completion progress bar on parent task in detail panel and card hover
- [ ] **SUB-04**: Epic→Story→Task hierarchy grouping in Table view — group-by-parent mode
- [ ] **SUB-05**: Task type validation on nesting — Epics can hold Stories+Tasks, Stories can hold Tasks, Tasks can't hold Epics

## Recurrence Completion (REC)

> Existing: picker in detail panel (6 options), recurrence.ts parser, badges on today/upcoming
> Missing: auto-create on completion, NewTaskModal picker, kanban badges

- [ ] **REC-01**: Auto-create next occurrence when recurring task completed — clone with next due date
- [ ] **REC-02**: Recurrence picker in NewTaskModal — same 6 options as detail panel
- [ ] **REC-03**: Recurrence badge (🔁) on kanban cards
- [ ] **REC-04**: Save recurrence_rule on task edit — wire td-recurrence select to saveTD

## Checklist Completion (CHK)

> Existing: full CRUD in detail panel, progress counter
> Missing: NewTaskModal checklists, progress on cards, template round-trip verification

- [ ] **CHK-01**: Checklist section in NewTaskModal — add checklist items during creation
- [ ] **CHK-02**: Checklist progress indicator on task cards across all views (kanban, table, today, upcoming)
- [ ] **CHK-03**: Verify template save/load preserves checklists correctly

## SQL Domain Migration (SQL)

- [ ] **SQL-01**: Create typed task query module in `@meitheal/domain-tasks` (findAll, findById, create, update, delete)
- [ ] **SQL-02**: Create board + label query modules in domain packages
- [ ] **SQL-03**: Migrate `/api/tasks/index.ts` and `/api/tasks/[id].ts` to domain queries
- [ ] **SQL-04**: Migrate `/api/boards/*` and `/api/labels*` routes
- [ ] **SQL-05**: Migrate remaining routes (comments, activity, templates, gamification, export)

## Page Decomposition (PGD)

- [ ] **PGD-01**: Extract Kanban inline script (~800 lines) to `lib/kanban-controller.ts`
- [ ] **PGD-02**: Extract Table inline script (~500 lines) to `lib/table-controller.ts`
- [ ] **PGD-03**: Extract Dashboard inline script (~300 lines) to `lib/dashboard-controller.ts`
- [ ] **PGD-04**: Extract Settings inline scripts to per-tab modules
- [ ] **PGD-05**: Extract Layout.astro scripts to `lib/layout-controller.ts`

## Smart Today + Tooling (SMT/VER)

- [ ] **SMT-01**: "Suggested" section on Today page — overdue + high-priority tasks surfaced
- [ ] **SMT-02**: Quick-add-to-today action — one-click focus
- [ ] **SMT-03**: Daily summary stats — completed/remaining/overdue counts
- [ ] **VER-01**: Create `scripts/check-version-sync.mjs` — validates version consistency
- [ ] **VER-02**: Add version sync check to CI pipeline
- [ ] **VER-03**: Create `scripts/bump-version.mjs` — atomic version update

## Settings Full Redesign (SET)

- [x] **SET-01**: Replace hidden Settings tab panes with a searchable shell, grouped navigation, summary cards, and hash deep-links
- [x] **SET-02**: Introduce `settings-registry.ts`, `settings-store.ts`, and `settings-page.ts` for section metadata, cached IO, and page orchestration
- [x] **SET-03**: Split Settings system content into canonical `personal`, `app & pwa`, and `danger zone` shell sections
- [x] **SET-04**: Fix cross-section routing so Webhooks points to `automation-ai-settings`
- [x] **SET-05**: Add Home Assistant Companion URL handler and x-callback-url affordances in App & PWA
- [x] **SET-06**: Update the dynamic manifest with real Settings screenshots and a Settings shortcut
- [x] **SET-07**: Add/refresh browser coverage for shell search, theme flows, and App & PWA contract checks
- [ ] **SET-08**: Verify ingress, companion, and PWA behavior in the HA devcontainer Tier 2 environment

## Scope

### v1 (this sprint)
All above — 28 requirements (reduced from 35 after audit)

### v2 (deferred)
- NLP quick add, calendar drag-to-reschedule, Pomodoro timer, time tracking UI
- File attachments, yearly heatmap, Drizzle adoption
- Full Layout.astro decomposition (beyond script extraction)

---

## Traceability

| Phase | Requirements |
|-------|-------------|
| 1 | SUB-01→05, REC-01→04, CHK-01→03 |
| 2 | SQL-01→05 |
| 3 | PGD-01→05 |
| 4 | SMT-01→03, VER-01→03 |
| 8 | SET-01→08 |

*Requirements revised: 2026-03-09 — post-audit, actual gaps only*
