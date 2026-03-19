# Core Feature Completion — Requirements (Revised)

**Project:** Meitheal Core Feature Completion Sprint
**Version:** v1.4 (updated after habits shell rollout — 2026-03-19)
**Date:** 2026-03-19

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

## Unified Page Shell Rollout (SHELL)

- [x] **SHELL-01**: Dashboard adopts `UnifiedBar` with hash-linked sections and Home Assistant-safe deep links
- [x] **SHELL-02**: Shared bar interactions are reusable outside Settings without settings-only DOM ids or selectors
- [x] **SHELL-03**: Dashboard keeps SearchHub launch, new-task action, and task-detail handoff intact after the shell migration
- [x] **SHELL-04**: Tier 1 browser verification covers dashboard section navigation plus core interaction regression checks
- [x] **SHELL-05**: Research/context/KCS artifacts record the rollout path for habits and the remaining pages
- [x] **SHELL-06**: Habits adopts `UnifiedBar` with hash-linked sections and Home Assistant-safe deep links
- [x] **SHELL-07**: Habits replaces the page-local inline script with a lifecycle-safe controller plus section registry
- [x] **SHELL-08**: Habits keeps create, edit, delete, complete, streak, and checklist flows intact after the shell migration
- [x] **SHELL-09**: Tier 1 browser verification covers habits shell navigation, SearchHub launch, and the habit modal entry point
- [x] **SHELL-10**: KCS/runbook/persona artifacts record the post-habits rollout order for Today, Upcoming, Calendar, Kanban, and Table
- [x] **SHELL-11**: Create a Step 0 audit lane with a 50-persona audit, consolidated report, and explicit page-context map for the remaining rollout pages
- [x] **SHELL-12**: Lock the two-layer shell decision in planning artifacts — `UnifiedBar` as primary shell, `TaskViewTabs` preserved for Calendar, Kanban, and Table
- [x] **SHELL-13**: Add a new 14.2→14.7 phase family covering reset, Today, Upcoming, Calendar, Kanban, and Table
- [x] **SHELL-14**: Generate persona-loop artifacts for the cross-page reset and record the installed tooling mismatch where relevant
- [x] **SHELL-15**: Goal-backward verify that prior shell deferrals and newly discovered page-context gaps are represented in the backlog
- [x] **SHELL-16**: Today adopts `UnifiedBar` with `today-overview`, `today-focus`, `today-triage`, `today-work`, and `today-habits`
- [x] **SHELL-17**: Today preserves clear-done, quick add, filters, focus stack, habits, SearchHub, Assist, and task-detail handoff after the shell migration
- [x] **SHELL-18**: Add Tier 1 browser coverage for the Today shell and its core actions
- [x] **SHELL-19**: Upcoming replaces inline scripts with a lifecycle-safe controller before adopting the unified shell
- [x] **SHELL-20**: Upcoming adopts `UnifiedBar` with `upcoming-overview`, `upcoming-next`, `upcoming-week`, and `upcoming-flow`
- [x] **SHELL-21**: Upcoming preserves day-group accordions, quick completion, task-detail handoff, SearchHub, and Assist after the shell migration
- [x] **SHELL-22**: Calendar replaces inline scripts with a lifecycle-safe controller before adopting the unified shell
- [x] **SHELL-23**: Calendar adopts `UnifiedBar` with `calendar-overview`, `calendar-month`, `calendar-agenda`, and `calendar-flow` while keeping `TaskViewTabs`
- [x] **SHELL-24**: Calendar preserves sync, month controls, inline previews, day drawer behavior, SearchHub, Assist, and route-switch continuity after the shell migration
- [x] **SHELL-25**: Kanban adopts `UnifiedBar` with `kanban-overview`, `kanban-lanes`, `kanban-fields`, and `kanban-flow` while keeping `TaskViewTabs`
- [x] **SHELL-26**: Kanban preserves lane management, filters, board interactions, SearchHub, Assist, and route-switch continuity after the shell migration
- [x] **SHELL-27**: Add Tier 1 browser coverage for the Kanban shell, lane actions, and route-switch continuity
- [x] **SHELL-28**: Table adopts `UnifiedBar` with `table-overview`, `table-filters`, `table-fields`, and `table-flow` while keeping `TaskViewTabs`
- [x] **SHELL-29**: Table preserves filters, saved presets, column customization, SearchHub, Assist, and route-switch continuity after the shell migration
- [x] **SHELL-30**: Add Tier 1 browser coverage for the Table shell and route-switch continuity
- [x] **SHELL-31**: Add Tier 1 browser coverage for the Upcoming and Calendar shell flows
- [x] **SHELL-32**: Add KCS/runbook coverage for Today, Upcoming, Calendar, Kanban, and Table shell behavior
- [ ] **SHELL-33**: Complete Tier 2 Home Assistant ingress and companion verification for the full cross-page shell program

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

## Docs Narrative & Surface Alignment (DOC)

- [x] **DOC-01**: Create a formal docs-refresh track with `04.3` context, research, plan, summary, verification, and a canonical persona-loop iteration
- [x] **DOC-02**: Update the existing codebase map in place for the documentation pass, with current protocol and integration surfaces reflected in planning artifacts
- [x] **DOC-03**: Rebuild the root `README.md` as a story-first guide for non-developer Home Assistant enthusiasts, organized around real jobs instead of a flat feature dump
- [x] **DOC-04**: Refresh duplicated `llms.txt` and `llms-full.txt` surfaces with synchronized language, verified route references, and per-surface MCP/LLM capability counts
- [x] **DOC-05**: Refresh add-on, custom-component, and protocol docs so Home Assistant, A2A, MCP, WebMCP, Assist, and companion flows are described accurately
- [x] **DOC-06**: Apply transitional ubiquitous language across public docs — `Area → Goal → Project → Task → Routine` is canonical, while legacy `task_type`, Epic/Story, board, and Vikunja compatibility terms are framed explicitly as compatibility surfaces
- [x] **DOC-07**: Refresh core README screenshots from the current UI and record Tier 1 verification for the documentation pass

## Scope

### v1 (this sprint)
All above — 33 requirements (expanded by the habits shell rollout follow-up)

### v2 (deferred)
- NLP quick add, calendar drag-to-reschedule, Pomodoro timer, time tracking UI
- File attachments, yearly heatmap, Drizzle adoption
- Full Layout.astro decomposition (beyond script extraction)

---

## Pre-Release Audit (PRA) — from 50-Persona Expert Audit

> [!IMPORTANT]
> These requirements were generated from a comprehensive 50-persona expert audit on 2026-03-18.
> Source: `.planning/persona-loops/pre-release-audit/50-persona-expert-audit.md`

### ADHD & Executive Function

- [ ] **PRA-01**: Add `quick_capture` task kind — zero-friction task creation with only title required, auto-assigns to backlog
- [ ] **PRA-02**: Smart Today Focus Stack — top 3 recommended tasks (overdue + due today + next routine) shown above full list
- [ ] **PRA-03**: Expand `OfflineTask` IDB schema to include priority, labels, project_id, task_kind, checklists, assigned_to, board_id (bump IDB v3)
- [ ] **PRA-04**: Kanban card 3-line rule — max 80px height, priority color strip, expand for details

### Bot Orchestration

- [ ] **PRA-05**: Bot Review Queue page (`/review`) — sidebar icon 📬 with count badge, grouped by bot, accept-all/reject-all
- [ ] **PRA-06**: Complete handoff state machine — add `failed`, `timeout`, `human_override` states + stale lock cleanup endpoint
- [ ] **PRA-07**: Exclude `agent_scratchpad` from all SELECT queries — never return in API responses
- [ ] **PRA-08**: Rate-limit bot endpoints (10 accepts/min, 60 writes/min per IP)

### Offline & Sync

- [ ] **PRA-09**: Field-family merge strategy — user_fields, bot_fields, meta_fields — per-family conflict resolution (not whole-row LWW)
- [ ] **PRA-10**: IDB cursor pagination — `getAllTasks(limit, offset)` and `getTasksByStatus(status)`
- [ ] **PRA-11**: Service Worker cache-first for static assets, network-first for API with IDB fallback
- [ ] **PRA-12**: Tab-sync conflict detection — version check on save with "modified elsewhere" prompt

### Home Assistant Integration

- [ ] **PRA-13**: WebSocket heartbeat (30s ping/pong) + exponential backoff reconnect (1-30s) + sidebar status indicator
- [ ] **PRA-14**: Register HA entities — `binary_sensor.meitheal_tasks_overdue`, `sensor.meitheal_active_tasks`, `sensor.meitheal_streak_days`
- [ ] **PRA-15**: Add hierarchy LLM tools — `list_areas`, `list_goals`, `list_projects`, `move_task_to_project`, `set_goal_progress`
- [ ] **PRA-16**: Detect HA Companion app and disable IndexedDB-based offline features gracefully

### n8n & MCP

- [ ] **PRA-17**: Webhook triggers — `task-created`, `task-completed`, `daily-summary` outbound events to configured n8n URL
- [ ] **PRA-18**: Implement 5 MCP core tools — `create_task`, `list_tasks`, `update_task`, `search_tasks`, `get_task` with handoff protocol

### Accessibility & UX

- [ ] **PRA-19**: WCAG 2.2 AA pass — skip-to-content link, heading hierarchy, keyboard DnD alternative, focus styles, color contrast
- [ ] **PRA-20**: Replace all `transition: all` with explicit property lists for performance
- [ ] **PRA-21**: Mobile bottom tab bar when `innerWidth < 768` — hide Meitheal sidebar for HA Companion
- [ ] **PRA-22**: Shadow and color token audit — replace all hardcoded `rgba()` with `var(--shadow-*)` tokens

### Schema & Architecture

- [ ] **PRA-23**: Schema version tracking via `app_settings.schema_version` — skip completed migrations on startup
- [ ] **PRA-24**: SQLite integrity check on startup — `PRAGMA integrity_check` with error surfacing
- [ ] **PRA-25**: Auto-backup on startup — copy DB to `.data/backups/`, keep max 5 (FIFO)
- [ ] **PRA-26**: Event listener cleanup pass — wrap all `addEventListener` in `pageLifecycle.onCleanup()`

### Goals & Planning

- [ ] **PRA-27**: Goal metrics — add `metric_type`, `metric_target`, `metric_current` columns for measurable OKR-style goals
- [ ] **PRA-28**: Progress rings — SVG circle on sidebar projects + goals showing completion percentage
- [ ] **PRA-29**: Weekly review endpoint — `/api/review/weekly` listing stale tasks, dormant projects, stagnant goals

### Gamification

- [ ] **PRA-30**: Streak freeze — 1 grace day/week without resetting streak, track `streak_freezes_used`

---

## Traceability

| Phase | Requirements |
|-------|-------------|
| 1 | SUB-01→05, REC-01→04, CHK-01→03 |
| 2 | SQL-01→05 |
| 3 | PGD-01→05 |
| 4 | SMT-01→03, VER-01→03 |
| 04.3 | DOC-01→07 |
| 8 | SET-01→12 |
| 14 | SHELL-01→05 |
| Parallel | STRAT-01→08 |
| 04.2-PRA | PRA-01→30 |

*Requirements revised: 2026-03-18 — Pre-release audit requirements from 50-persona expert audit*
