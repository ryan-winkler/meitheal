# Core Feature Completion — Requirements (Revised)

**Project:** Meitheal Core Feature Completion Sprint
**Version:** v1.3 (updated after Strategic Rules pivot — 2026-03-16)
**Date:** 2026-03-16

> [!IMPORTANT]
> Requirements now reflect the current repository state after Phases 1, 2, 4 and the Settings redesign work landed.

---

## Subtask Hierarchy UI (SUB)

- [x] **SUB-01**: Table tree indent — child tasks indented under parent with expand/collapse toggles
- [x] **SUB-02**: "Add subtask" button in task detail panel — opens inline quick-create form with parent_id auto-set
- [x] **SUB-03**: Subtask completion progress bar on parent task in detail panel and card hover
- [x] **SUB-04**: Epic→Story→Task hierarchy grouping in Table view — group-by-parent mode
- [x] **SUB-05**: Task type validation on nesting — Epics can hold Stories+Tasks, Stories can hold Tasks, Tasks can't hold Epics

## Recurrence Completion (REC)

- [x] **REC-01**: Auto-create next occurrence when recurring task completed — clone with next due date
- [x] **REC-02**: Recurrence picker in NewTaskModal — same 6 options as detail panel
- [x] **REC-03**: Recurrence badge (🔁) on kanban cards
- [x] **REC-04**: Save recurrence_rule on task edit — wire td-recurrence select to saveTD

## Checklist Completion (CHK)

- [x] **CHK-01**: Checklist section in NewTaskModal — add checklist items during creation
- [x] **CHK-02**: Checklist progress indicator on task cards across all views (kanban, table, today, upcoming)
- [x] **CHK-03**: Verify template save/load preserves checklists correctly

## SQL Domain Migration (SQL)

- [x] **SQL-01**: Create typed task query module in `@meitheal/domain-tasks` (findAll, findById, create, update, delete)
- [x] **SQL-02**: Create board + label query modules in domain packages
- [x] **SQL-03**: Migrate `/api/tasks/index.ts` and `/api/tasks/[id].ts` to domain queries
- [x] **SQL-04**: Migrate `/api/boards/*` and `/api/labels*` routes
- [x] **SQL-05**: Migrate remaining routes (comments, activity, templates, gamification, export)

## Page Decomposition (PGD)

- [x] **PGD-01**: Extract Kanban inline script (~800 lines) to `lib/kanban-controller.ts`
- [x] **PGD-02**: Extract Table inline script (~500 lines) to `lib/table-controller.ts`
- [x] **PGD-03**: Extract Dashboard inline script (~300 lines) to `lib/dashboard-controller.ts`
- [x] **PGD-04**: Refactor Settings page orchestration into `settings-page.ts` + shell/store/registry modules and remove duplicated component page-load listeners
- [x] **PGD-05**: Extract Layout.astro module scripts to `lib/layout-body-controller.ts`, `lib/layout-shortcuts-controller.ts`, `lib/layout-pwa-controller.ts`

## Smart Today + Tooling (SMT/VER)

- [x] **SMT-01**: "Suggested" section on Today page — overdue + high-priority tasks surfaced
- [x] **SMT-02**: Quick-add-to-today action — one-click focus
- [x] **SMT-03**: Daily summary stats — completed/remaining/overdue counts
- [x] **VER-01**: Create `scripts/check-version-sync.mjs` — validates version consistency
- [x] **VER-02**: Add version sync check to CI pipeline
- [x] **VER-03**: Create `scripts/bump-version.mjs` — atomic version update

## Settings Full Redesign (SET)

- [x] **SET-01**: Replace hidden Settings tab panes with a searchable shell, grouped navigation, summary cards, and hash deep-links
- [x] **SET-02**: Introduce `settings-registry.ts`, `settings-store.ts`, and `settings-page.ts` for section metadata, cached IO, and page orchestration
- [x] **SET-03**: Split Settings system content into canonical `personal`, `app & pwa`, and `danger zone` shell sections
- [x] **SET-04**: Fix cross-section routing so Webhooks points to `automation-ai-settings`
- [x] **SET-05**: Add Home Assistant Companion URL handler and x-callback-url affordances in App & PWA
- [x] **SET-06**: Update the dynamic manifest with real Settings screenshots and a Settings shortcut
- [x] **SET-07**: Add/refresh browser coverage for shell search, theme flows, and App & PWA contract checks
- [ ] **SET-08**: Verify ingress, companion, and PWA behavior in the HA devcontainer Tier 2 environment
- [x] **SET-09**: Differentiate summary, rail, and section intro roles using registry-backed UX metadata and shared settings primitives
- [x] **SET-10**: Improve settings search with visible reset, result metadata, and keyboard navigation
- [x] **SET-11**: Add mobile quick-jump UX plus guided App & PWA and Danger Zone trust surfaces
- [ ] **SET-12**: Re-run Tier 2 HA verification for the polished Settings UX once Docker access is available

## Smart Today Maturation (STM)

- [x] **STM-01**: Unified `TaskListItem.astro` component shared across Today + all views
- [x] **STM-02**: `today-controller.ts` with keyboard nav, filter bar, sort, all actions
- [x] **STM-03**: Full list-view feature parity (G01-G11: favorite, ticket key, RICE, actions, keyboard, filters, persistence, toasts, confirm, i18n, sort)
- [x] **STM-04**: Today-specific enhancements (G12-G17: snooze, shopping list, quick-add defaults, carried forward, delete, clear completed)
- [x] **STM-05**: Habits section with TemplateRepository, streak display, complete button (G38)
- [x] **STM-06**: Save-as-Habit action on task cards (G39)
- [x] **STM-07**: Recurrence management — auto-link, prompts, cascade cancel, 2-month cleanup (G40-G42)
- [x] **STM-08**: Enhanced Today — pinned/MITs, custom fields, color dot, progress bar, calendar sync, celebration, deep-link, board context, overdue styling (G18-G26)
- [x] **STM-09**: Daily migration prompt for morning triage of carried-forward tasks (G27)
- [x] **STM-10**: Calendar events from HA — multi-calendar, client-hydrated, graceful degradation (G28)
- [x] **STM-11**: Context grouping by @-prefix labels with threshold and icons (G29)
- [x] **STM-12**: Advanced features — batch actions, drag reorder, WIP limit, polling, evening review, effort indicators, gamification, HA widget (G30-G37)
- [x] **STM-13**: List view removal — tasks.astro deleted, TaskViewTabs updated
- [x] **STM-14**: Today page E2E test suite (`today-page.spec.ts`, 30+ tests)
- [ ] **STM-15**: Tier 2 HA verification of calendar events + habits integration

## Strategic Rules Engine (STRAT)

- [x] **STRAT-01**: Domain strategy package — rule types, framework config types, rule resolver (`domain-strategy`)
- [x] **STRAT-02**: Persistence — `rules` + `framework_configs` SQLite tables + repository modules
- [x] **STRAT-03**: API — `/api/rules` CRUD, `/api/rules/resolve`, `/api/frameworks` CRUD
- [x] **STRAT-04**: Settings UI — per-type framework assignment, AI scope toggles, presets, framework config editor
- [x] **STRAT-05**: Task view integration — `StrategicEvaluator.astro` uses rule resolver, `FrameworkBadge.astro` generalized badge
- [x] **STRAT-06**: KCS checklist mode — checkbox UI type, boolean value handling, completed/total sidebar badge
- [x] **STRAT-07**: Backup integration — export/import v2 format (rules + frameworks), restore defaults API with confirmation
- [x] **STRAT-08**: Domain tests — 9 passing tests for rule resolution + weighted RICE scoring

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
| 8 | SET-01→12 |
| Parallel | STRAT-01→08 |

*Requirements revised: 2026-03-16 — Strategic Rules engine delivered*
