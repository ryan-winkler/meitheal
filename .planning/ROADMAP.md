# Core Feature Completion — Roadmap (Revised)

**Project:** Meitheal Core Feature Completion Sprint
**Phases:** 4 (consolidated from 6 after audit)
**Requirements:** 28
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

*Roadmap revised: 2026-03-15 — phase status and parallel tracks refreshed*
