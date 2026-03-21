# Core Feature Completion — Roadmap (Revised)

**Project:** Meitheal Core Feature Completion Sprint
**Phases:** 4 (consolidated from 6 after audit)
**Requirements:** 33
**Date:** 2026-03-15
**Status:** 🔄 Core phases complete, parallel polish phases active

> Reduced from 6 to 4 phases — Subtask/Recurrence/Checklist merged into Phase 1
> since most UI already exists and gaps are interconnected.

---

## Progress

| # | Phase | Status | Date |
|---|-------|--------|------|
| 1 | Hierarchy + Feature Gaps | ✅ Complete | 2026-03-09 |
| 2 | SQL Domain Migration | ✅ Complete | 2026-03-09 |
| 3 | Page Decomposition | 🟡 Partial | 2026-03-15 |
| 4 | Smart Today + Tooling | ✅ Complete | 2026-03-15 |

## Parallel Phase 08: Settings Full Redesign

**Status:** 🟡 Local implementation complete, Tier 2 HA verification blocked by environment

**Goal:** Replace the legacy Settings tab stack with a searchable, Astro-native shell that works cleanly behind Home Assistant ingress, inside the companion app, and as a PWA.

**Requirements:** SET-01→08

**Success Criteria:**
1. Settings uses grouped shell navigation with hash deep-links instead of hidden tab panes.
2. Registry/store/page orchestration removes duplicated client ownership for section metadata and settings IO.
3. Webhooks → Automation & AI linking uses canonical section ids.
4. App & PWA exposes installability state plus Home Assistant Companion URL handler and x-callback-url affordances.
5. Manifest metadata includes real Settings screenshots and a Settings shortcut.
6. Theme/settings shell Playwright coverage passes locally.
7. HA devcontainer verification confirms ingress-safe behavior before phase closeout.

**Dependencies:** None for local delivery. Tier 2 closeout depends on Docker access for the HA devcontainer.

## Parallel Phase 08.1: Settings UI/UX Polish

**Status:** 🟡 Local implementation complete, Tier 2 HA verification blocked by environment

**Goal:** Polish the redesigned Settings shell so it feels intentionally navigable on desktop, mobile, Home Assistant ingress, and PWA/companion surfaces.

**Success Criteria:**
1. Summary strip stays visible as the primary quick-jump/live-status surface in detail mode.
2. Search supports result metadata, arrow-key navigation, and a visible clear/reset path.
3. Mobile uses a compact section-picker quick-jump surface instead of a shrunken desktop rail.
4. Shared settings primitives reduce repeated card/callout/disclosure markup across the settings panels.
5. App & PWA and Danger Zone present guided trust surfaces instead of raw control clusters.
6. Tier 1 browser verification covers reset, keyboard, and mobile navigation flows.
7. Tier 2 HA verification confirms ingress-safe behavior once Docker access is available.

## Parallel Phase 09: Search Hub Upgrade

**Status:** 🟡 Local implementation complete, Tier 2 HA verification blocked by environment

**Goal:** Replace Meitheal's split task search and command palette with one Astro-native, Home Assistant-native search hub that can search tasks, views, settings, saved filters, and actions.

**Success Criteria:**
1. The topbar launcher and `Cmd/Ctrl+K` open the same universal search surface.
2. Task search supports IDs, titles, descriptions, labels, custom fields, comments, completed/archive toggles, and relevance vs updated sorting.
3. Search can return boards, saved filters, settings anchors, and quick actions.
4. HA search service, LLM API, and MCP all reuse the upgraded task-search path.
5. Public contracts, KCS docs, and phase artifacts reflect the new `/api/search` behavior.
6. Tier 1 browser verification covers hub launch and at least one navigation flow.
7. Tier 2 HA verification confirms ingress-safe behavior once Docker access is available.

## Parallel Phase 14: Unified Page Shell Rollout

**Status:** ✅ Dashboard-first slice complete

**Goal:** Apply the mature Settings shell language to the dashboard first, then use that implementation to drive the rollout plan for habits and other Home Assistant-facing pages.

**Requirements:** SHELL-01→05

**Success Criteria:**
1. Dashboard uses `UnifiedBar` plus hash-based section navigation instead of the legacy topbar slot layout.
2. Shared bar behavior is reusable outside Settings without reintroducing settings-only ids or controller assumptions.
3. Dashboard search launches the global SearchHub with the right scope and keeps Home Assistant ingress behavior intact.
4. Dashboard browser verification covers section navigation, quick add, and task detail handoff after the shell change.
5. Research, context, and optimization artifacts capture the next rollout order for habits and the remaining pages.

**Dependencies:** Phase 08/08.1 shell patterns, Phase 09 SearchHub, Layout ingress fetch wrapper.

## Parallel Phase 14.1: Habits Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Apply the mature Settings/dashboard shell language to `/habits` while replacing the page-local inline script with an Astro-first, lifecycle-safe controller path.

**Requirements:** SHELL-06→10

**Success Criteria:**
1. Habits uses `UnifiedBar`, hash-linked sections, and Home Assistant-safe deep links instead of a bespoke header.
2. The habits page loads its initial routine data server-side and boots a lifecycle-safe controller instead of a long inline page script.
3. Habit create, edit, delete, complete, checklist, and streak flows remain intact after the shell migration.
4. Tier 1 browser verification covers habits section navigation, SearchHub launch, and the shared habit-create modal.
5. Research, persona-loop, KCS, and runbook artifacts capture the next rollout order for Today, Upcoming, Calendar, Kanban, and Table.

**Dependencies:** Parallel Phase 14 dashboard shell helpers, `/api/habits`, `TemplateRepository`, `pageLifecycle`.

## Parallel Phase 14.2: Unified Bar Cross-Page Reset

**Status:** ✅ Local reset complete

**Goal:** Reset the remaining shell rollout around one explicit cross-page audit, page-context map, persona-loop, and backlog so Today, Upcoming, Calendar, Kanban, and Table can adopt the mature shell without losing route-switch context.

**Requirements:** SHELL-11→15

**Success Criteria:**
1. Step 0 audit lane exists with a 50-persona audit, consolidated report, and explicit page-context map.
2. Roadmap, requirements, and state record a new 14.2→14.7 phase family for the remaining pages.
3. The two-layer shell decision is locked: `UnifiedBar` for top-level page sections, `TaskViewTabs` preserved on Calendar, Kanban, and Table.
4. Persona-loop artifacts exist for the cross-page reset and record any tooling mismatches discovered while following the installed workflow.
5. Verification confirms that older shell deferrals and newly discovered optimizations are represented in the backlog before code delivery starts.

**Dependencies:** Parallel Phases 14 and 14.1, SearchHub upgrade, current codebase map, and Home Assistant companion route guidance.

## Parallel Phase 14.3: Today Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Apply the mature unified shell to `/today` and reframe the existing Today cockpit into explicit overview, focus, triage, work, and habits sections.

**Requirements:** SHELL-16→18

**Success Criteria:**
1. Today uses `UnifiedBar` with `today-overview`, `today-focus`, `today-triage`, `today-work`, and `today-habits`.
2. Existing Today interactions remain intact: clear done, quick add, filters, focus stack, task-detail handoff, and habits section.
3. SearchHub and Assist launch from the shell without introducing duplicate page-local launchers.
4. Tier 1 browser verification covers shell navigation, search, new-task launch, and the existing Today action surfaces.

**Dependencies:** Phase 14.2 reset artifacts, existing `today-controller.ts`, SearchHub, pageLifecycle.

## Parallel Phase 14.4: Upcoming Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Extract `/upcoming` into a lifecycle-safe controller, then apply the unified shell while preserving direct completion, day-group accordions, and Today/Calendar handoff.

**Requirements:** SHELL-19→21

**Success Criteria:**
1. Upcoming replaces its inline scripts with a dedicated controller before the shell rollout lands.
2. Upcoming uses `UnifiedBar` with `upcoming-overview`, `upcoming-next`, `upcoming-week`, and `upcoming-flow`.
3. Day-group accordion behavior, quick completion, and task-detail handoff continue to work after the shell migration.
4. Tier 1 browser verification covers shell navigation, search, create-task handoff, and completion from the grouped list.

**Dependencies:** Phase 14.2 reset artifacts, SearchHub, pageLifecycle, shared task APIs.

## Parallel Phase 14.5: Calendar Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Extract `/calendar` into a lifecycle-safe controller, then apply the unified shell while preserving month controls, HA sync, day drawer behavior, and the secondary task-view switcher.

**Requirements:** SHELL-22→24

**Success Criteria:**
1. Calendar replaces its inline scripts with a dedicated controller before the shell rollout lands.
2. Calendar uses `UnifiedBar` with `calendar-overview`, `calendar-month`, `calendar-agenda`, and `calendar-flow`, while keeping `TaskViewTabs` beneath it.
3. Prev/next/today controls, sync action, inline previews, and day drawer behavior remain intact.
4. Tier 1 browser verification covers shell navigation, search, sync action, day drawer open, and route-switch continuity.

**Dependencies:** Phase 14.2 reset artifacts, SearchHub, pageLifecycle, calendar sync APIs, `TaskViewTabs`.

## Parallel Phase 14.6: Kanban Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Apply the mature shell to `/kanban` without flattening lane management, field customization, or route-switch context.

**Requirements:** SHELL-25→27

**Success Criteria:**
1. Kanban uses `UnifiedBar` with `kanban-overview`, `kanban-lanes`, `kanban-fields`, and `kanban-flow`, while keeping `TaskViewTabs` beneath it.
2. `Manage Lanes` and `New Task` remain shell actions; field emphasis moves into the page sections instead of competing with the action cluster.
3. Existing filter, board, drag, quick-action, and task-detail behavior remain intact after the shell migration.
4. Tier 1 browser verification covers shell navigation, search, manage-lanes, new-task launch, and route-switch continuity.

**Dependencies:** Phase 14.2 reset artifacts, existing `kanban-controller.ts`, SearchHub, pageLifecycle, `TaskViewTabs`.

## Parallel Phase 14.7: Table Shell Rollout

**Status:** ✅ Local implementation complete

**Goal:** Apply the mature shell to `/table` without flattening filters, presets, fields, or route-switch context.

**Requirements:** SHELL-28→30

**Success Criteria:**
1. Table uses `UnifiedBar` with `table-overview`, `table-filters`, `table-fields`, and `table-flow`, while keeping `TaskViewTabs` beneath it.
2. Filter toolbar, saved presets, column customizer, and raw table behavior remain intact after the shell migration.
3. `New Task` remains the shell action while field and filter density move into anchored sections.
4. Tier 1 browser verification covers shell navigation, search, new-task launch, and route-switch continuity.

**Dependencies:** Phase 14.2 reset artifacts, existing `table-controller.ts`, SearchHub, pageLifecycle, `TaskViewTabs`.

## Parallel Phase 08.2: Settings Controller Decomposition

**Status:** 🔵 In Progress

**Goal:** Decompose the 3,561-line `settings-controller.ts` monolith into 6 domain-aligned controller modules, remove anti-patterns (reload hacks, inline styles), and expand test coverage.

**Requirements:** SET-13→18

**Success Criteria:**
1. `settings-controller.ts` is ≤200 LoC, acting as a thin orchestrator importing domain controllers.
2. 6 new controller files (`theme`, `sidebar`, `integrations`, `ai`, `data`, `danger`) each own exactly one settings-registry section.
3. Shared utilities (`saveSetting`, `loadSettings`) extracted to `settings-utils.ts`.
4. Zero `window.location.reload()` calls remain — replaced with reactive DOM updates.
5. Zero type errors in `pnpm check`.
6. All existing e2e tests pass with no regressions.
7. Settings page functions identically when accessed via browser, ingress, and PWA.

---

## Phase 1: Hierarchy + Feature Gaps

**Goal:** Complete the Epic→Story→Task hierarchy across all views, fill remaining subtask/recurrence/checklist UI gaps, and ensure parent/children relationships ebb and flow together.

**Requirements:** SUB-01→05, REC-01→04, CHK-01→03 (12 requirements)

**Success Criteria:**
1. Table view shows parent/child tree with indent + expand/collapse
2. Epic→Story→Task nesting rules enforced (Epic→Story→Task, not Task→Epic)
3. "Add subtask" button in detail panel creates child with correct parent_id
4. Completing a recurring task auto-creates next occurrence with correct due date
5. Kanban cards show recurrence badge (🔁) like today/upcoming already do
6. NewTaskModal has recurrence picker and checklist section
7. Subtask progress bar visible on parent tasks
8. Checklist progress visible on cards across all views

**Dependencies:** None — building on existing infrastructure.

---

## Phase 2: SQL Domain Migration

**Goal:** Extract inline SQL from API routes into typed domain package functions.

**Requirements:** SQL-01→05 (5 requirements)

**Success Criteria:**
1. `@meitheal/domain-tasks` exports typed CRUD functions
2. All task/board/label API routes use domain queries
3. Remaining routes (comments, templates, gamification, export) migrated
4. Zero test regressions

**Dependencies:** Phase 1 (new features write domain queries from day one).

---

## Phase 3: Page Decomposition

**Goal:** Extract inline scripts from monolith Astro pages into typed modules.

**Requirements:** PGD-01→05 (5 requirements)

**Success Criteria:**
1. Kanban, Table, Dashboard scripts extracted to typed `.ts` modules
2. Settings page orchestration extracted into `settings-page.ts` plus shell/store/registry modules, with no duplicated component page-load ownership
3. Layout.astro scripts extracted to `lib/layout-controller.ts`
4. All modules type-check via `astro check`

**Dependencies:** Phase 2 (extracted scripts should use domain queries).

---

## Phase 4: Smart Today + Tooling

**Goal:** Smart task suggestions + developer tooling for version management.

**Requirements:** SMT-01→03, VER-01→03 (6 requirements)

**Success Criteria:**
1. Today page "Suggested" section with overdue + high-priority tasks
2. One-click add-to-today from suggestions
3. Daily summary stats
4. Version sync check script + CI integration
5. Atomic version bump script

**Dependencies:** None (can run in parallel with Phase 3).

---

### Phase 04.1: Human-Agent DDD Core

**Goal:** Replace `Epic -> Story -> Task` with `Area -> Goal -> Project -> Task -> Routine`, add bot-safe orchestration primitives, and define an offline-safe merge and compatibility translation strategy before execution.

**Status:** ✅ Schema + Domain Logic Complete | 🔜 API routes + UI (Phase 04.2)

**Success Criteria:**
1. ✅ `Goal` and `Project` are treated as aggregate roots, not `task_type` aliases.
2. ✅ `Task` behavior is modeled via `task_kind` (`standard_action`, `shopping_item`, `checklist`, `routine_instance`) instead of hierarchy labels.
3. ✅ Bot handoff uses explicit owner, lock, orchestration, proposal, and audit-ledger primitives.
4. 🔜 Offline/PWA sync has a documented field-family merge strategy instead of whole-row last-write-wins.
5. ✅ HA todo and Vikunja translation rules are defined without bloating the core UI model.

**Sub-Phases:**

| # | Sub-Phase | Status | Files Changed |
|---|-----------|--------|---------------|
| 04.1a | Schema Foundation | ✅ | `store.ts`, `domain-model.ts`, `task.ts`, `index.ts` |
| 04.1b | Bot Orchestration Core | ✅ | `handoff.ts`, `store.ts`, `task-repository.ts` |
| 04.1c | Integration Translation | ✅ | `todo-bridge.ts`, verified: vikunja-compat, offline-store |
| 04.1d | Ubiquitous Language Cleanup | ✅ | `template-repository.ts`, `habits.ts`, `habits.astro` |

**Test Coverage:** 64 new tests (schema-validation: 15, hierarchy-model: 8, handoff-state-machine: 41)

**Depends on:** Phase 4
**Plans:** Completed — see [ADR-007](file:///home/ryan/code/meitheal/docs/decisions/ADR-007-hierarchy-model.md)

### Phase 04.2: Hierarchy API + UI (Planned)

**Goal:** Expose areas/goals/projects via API routes and build sidebar navigation tree + project views.

**Status:** 📋 Planned

**Requirements:**
1. API routes: `/api/areas`, `/api/goals`, `/api/projects` (CRUD)
2. Sidebar navigation tree component
3. Project detail view
4. Bot badge indicators on tasks
5. Goal progress visualization

**Depends on:** Phase 04.1

### Parallel Phase 04.3: Docs Narrative & Surface Alignment

**Status:** ✅ Complete

**Goal:** Rebuild Meitheal's public story so README, machine-readable docs, add-on docs, and protocol docs reflect the current product, the newer ubiquitous language, and the real Home Assistant-native surface area.

**Requirements:** DOC-01→07

**Success Criteria:**
1. README explains Meitheal as a Home Assistant-native household and homelab execution hub, not just a feature list.
2. Public docs organize capabilities around real user jobs: capture, plan, work, sync, stay available everywhere, and collaborate with voice/AI/agents.
3. Canonical docs use transitional ubiquitous language: `Area → Goal → Project → Task → Routine` is primary, while legacy `task_type`, Epic/Story, boards, and Vikunja terms are called out as compatibility surfaces.
4. `llms.txt`, `llms-full.txt`, add-on docs, protocol docs, and custom-component docs use verified route references and capability counts per surface instead of one global number.
5. A formal docs-refresh phase and persona-loop artifact set exist in `.planning/` for future refreshes.
6. README screenshots match the current dashboard, settings, and work/search surfaces.

**Dependencies:** Existing codebase map, DDD audit artifacts, ADR-007 hierarchy model, and current protocol implementations in Astro and the Home Assistant custom component.

---

## Pre-Release Audit Phases (from 50-Persona Expert Audit)

### Phase 05.1: Schema & Architecture Hardening

**Goal:** Make the database startup fast, safe, and observable. Prevent corruption, track schema versions, auto-backup.

**Status:** 📋 Planned

**Requirements:** PRA-23, PRA-24, PRA-25, PRA-01, PRA-27, PRA-30

**Success Criteria:**
1. Schema version tracked in `app_settings` — startup skips completed migrations
2. `PRAGMA integrity_check` runs on startup with error surfacing to `/api/health`
3. Auto-backup copies DB to `.data/backups/` on startup (max 5, FIFO)
4. `quick_capture` task kind accepted by `/api/tasks` with only title required
5. Goals table has `metric_type`, `metric_target`, `metric_current` columns
6. Streak freeze logic — 1 grace day/week without resetting streak

**Depends on:** Phase 04.1

---

### Phase 05.2: Bot Orchestration Completion

**Goal:** Complete the bot handoff lifecycle — review queue UI, state machine gaps, scratchpad isolation, rate limiting.

**Status:** 📋 Planned

**Requirements:** PRA-05, PRA-06, PRA-07, PRA-08

**Success Criteria:**
1. `/review` page shows pending bot proposals grouped by bot with accept-all/reject-all
2. Sidebar shows 📬 icon with pending count badge
3. Handoff state machine includes `failed`, `timeout`, `human_override` states
4. Stale lock cleanup runs on configurable interval
5. `agent_scratchpad` never appears in any API response
6. Bot write endpoints rate-limited (60/min per IP)

**Depends on:** Phase 05.1

---

### Phase 05.3: Offline & PWA Resilience

**Goal:** Make offline mode actually useful — field-family merge, expanded IDB schema, proper SW caching, tab sync.

**Status:** 📋 Planned

**Requirements:** PRA-03, PRA-09, PRA-10, PRA-11, PRA-12

**Success Criteria:**
1. `OfflineTask` includes all 14 essential task fields, IDB version = 3
2. Field-family merge strategy implemented (user_fields, bot_fields, meta_fields)
3. IDB cursor pagination via `getAllTasks(limit, offset)`
4. Service Worker caches static assets on install; serves cached when offline
5. Tab-sync shows conflict prompt when task modified in another tab

**Depends on:** Phase 05.1

---

### Phase 05.4: Home Assistant Deep Integration

**Goal:** Make Meitheal a first-class HA citizen — WebSocket hardening, entity registration, LLM tools, Companion detection.

**Status:** 📋 Planned

**Requirements:** PRA-13, PRA-14, PRA-15, PRA-16

**Success Criteria:**
1. WebSocket auto-reconnects within 30s with exponential backoff
2. Sidebar shows real-time HA connection status
3. 3 HA entities registered (overdue sensor, active count, streak)
4. 5 hierarchy-aware LLM tools available via HA Assist
5. Companion app detected — IDB features gracefully disabled

**Depends on:** Phase 05.2

---

### Phase 05.5: Accessibility & UX Polish

**Goal:** WCAG 2.2 AA compliance, mobile responsiveness, animation performance, visual token consistency.

**Status:** 📋 Planned

**Requirements:** PRA-04, PRA-19, PRA-20, PRA-21, PRA-22, PRA-26, PRA-28, PRA-29, PRA-02

**Success Criteria:**
1. Lighthouse accessibility score ≥ 90
2. Skip-to-content link, correct heading hierarchy, keyboard DnD alternative
3. All `transition: all` replaced with explicit property lists
4. Mobile (< 768px) shows bottom tab bar, sidebar hidden
5. All hardcoded `rgba()` shadow values replaced with `var(--shadow-*)` tokens
6. Event listeners wrapped in `pageLifecycle.onCleanup()`
7. Progress rings on sidebar projects and goals
8. Focus Stack (top 3 tasks) on Today page
9. Kanban cards ≤ 80px with priority strip

**Depends on:** Phase 05.3

---

### Phase 05.6: n8n & MCP Integration

**Goal:** Connect Meitheal to the automation ecosystem — n8n webhook triggers and functional MCP tools.

**Status:** 📋 Planned

**Requirements:** PRA-17, PRA-18

**Success Criteria:**
1. 3 webhook events fire on configured URL (task-created, task-completed, daily-summary)
2. 5 MCP core tools functional (create, list, update, search, get)
3. MCP tools respect `bot_allow_proposals` setting
4. MCP tools use handoff protocol (claim → propose → await human accept)

**Depends on:** Phase 05.2

---

## Phase 15: Hierarchy Architecture Overhaul

**Goal:** Resolve Area/Project duplication in sidebar, integrate calendar events as task_kind, add direct goal→task relationships, create "Every Day" default project, build routine template system, and consolidate Goals/Routines/Achievements under a unified "Progress & Growth" parent page.

**Status:** 📋 Planning (GSD research/discuss/persona workflows in progress)

**Requirements:** HIR-01→12 (to be defined after research phase)

**Success Criteria:**
1. Sidebar shows single unified AREAS tree — no separate Area dropdown section
2. `calendar_event` task_kind accepted, synced tasks backfilled
3. Tasks can have direct `goal_id` or inherit from parent project
4. "Every Day" default project auto-created, undeletable, primary capture target
5. Routine template CRUD with scheduled instance spawning and streak tracking
6. `/progress` parent page with Routines | Goals | Achievements sub-menu tabs
7. `/gamification` renamed to Achievements, `/habits` and `/goals` redirect to `/progress` sub-sections
8. Three-tier helper/explainer system with `?` key recall panel
9. API tolerant reader pattern — empty update body returns 200, not 400
10. Ubiquitous language glossary in `docs/kcs/hierarchy-glossary.md`
11. `/areas` index page with grid view of all areas (goal/project counts)
12. `/areas/[id]` detail page with sub-menu tabs: Overview | Goals | Projects | Settings
13. `/projects/[id]` detail page with sub-menu tabs: Overview | Tasks | Fields | Settings
14. Sidebar hierarchy tree items link to their respective Area/Project detail pages

**Depends on:** Phase 04.1 (DDD Core — complete), Phase 04.2 (Hierarchy API — complete)

---

---

## Phase 16: Tasks Layout Redesign

**Goal:** Unify Kanban, Table, Calendar, and Timeline views under a single `/tasks` page with client-side hash-based view switching, a first-class Area/Space selector, a composable filter row with progressive disclosure, and a dedicated Customize panel. Inspired by modern task management UX patterns while staying Astro-native and HA ingress-safe.

**Status:** 📋 Planning (GSD research + persona loop in progress)

**Requirements:** TLR-01→16

**Sub-phases:**

| # | Sub-phase | Requirements | Depends On |
|---|-----------|-------------|------------|
| 16.1 | Client-Side View Switching | TLR-01→04 | None |
| 16.2 | Area/Space Selector | TLR-05→07 | 16.1 |
| 16.3 | Unified Filter Row | TLR-08→12 | 16.1 |
| 16.4 | Customize Panel | TLR-13→16 | 16.1, 16.3 |

**Success Criteria:**
1. All 4 task views load under `/tasks` with `#hash` switching and zero page reloads
2. Legacy routes (`/table`, `/calendar`, `/timeline`, `/kanban`) redirect to `/tasks#view`
3. Area selector in UnifiedBar scopes all views, persists across sessions
4. Filter state preserved across view switches
5. Type pills with progressive disclosure replace monolithic FilterToolbar
6. Customize panel provides per-view configuration
7. E2E tests pass for view switching, area filtering, and legacy redirects
8. HA ingress verification confirms no redirect loops

**Depends on:** Phase 05.3 (Unified Page Shell)

---

---

## Phase 17: Pillars Domain

**Goal:** Introduce "Pillars" as permanent motivational anchors — the WHY layer — into Meitheal's hierarchy. Pillars answer "WHO am I?" and provide identity-based framing for Goals, Routines, and Tasks. Distinct from Goals (WHAT), Areas (WHERE), Lenses (HOW), and Habits (REPEAT).

**Status:** 🔨 In Progress (GSD persona loop complete, execution wave 1)

**Requirements:** PIL-01→09

**Wave structure:**

| Wave | Tasks | What it builds |
|------|-------|----------------|
| 1 | T1–T4, T7, T14 | Domain service, schema, types, ADR, glossary |
| 2 | T10 | REST API routes |
| 3 | T5, T6, T9, T11, T12 | UI: registry, components, controller, page section |
| 4 | T8, T13 | Scope guard verification + E2E tests |

**Success Criteria:**
1. `pillar-service.ts` passes all CRUD + association E2E tests
2. Pillars section visible on `/habits` page under UnifiedBar
3. Create/edit/delete Pillar works with identity-framing placeholder
4. Soft-limit warning at 6th Pillar, no hard block
5. PillarSelector in Goal/Routine create modals links entities
6. No shame language, no red badges, no failure states anywhere
7. All existing tests pass (`pnpm --filter @meitheal/tests test`)
8. Typecheck clean (`pnpm check`)

**Depends on:** None (independent bounded context)

---

*Roadmap revised: 2026-03-21 — Phase 17 pillars domain from 50-persona GSD persona loop*
