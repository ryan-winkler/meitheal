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

*Roadmap revised: 2026-03-18 — Pre-release audit phases (05.1–05.6) from 50-persona expert audit*
