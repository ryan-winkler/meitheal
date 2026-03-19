---
scope: unified-bar-cross-page (Phases 14.2-14.7)
checked: 2026-03-19T23:06:00Z
status: gaps_found
---

# Unified Bar — Integration Check Report

**Scope:** UnifiedBar component, page-shell-controller, and all page integrations
**Method:** Export/import mapping, API coverage, E2E flow tracing

## Wiring Summary

| Category | Connected | Orphaned | Missing |
|----------|-----------|----------|---------|
| Component imports | 8 pages | 0 | 1 (Eisenhower) |
| Controller wiring | 5 pages | 0 | 1 (Eisenhower) |
| Section registries | 7/7 | 0 | 0 |
| API consumers | ~80 | 20+ | 0 |

## Component → Page Wiring

### UnifiedBar.astro

| Page | Imports UnifiedBar | Uses `slot="custom-header"` | Custom `slot="actions"` | barId |
|------|-------------------|---------------------------|------------------------|-------|
| Today | ✅ | ✅ | ✅ (Clear Done btn) | `today-bar` |
| Upcoming | ✅ | ✅ | ❌ | `upcoming-bar` |
| Calendar | ✅ | ✅ | ✅ (Sync btn) | `calendar-bar` |
| Kanban | ✅ | ✅ | ❌ | `kanban-bar` |
| Table | ✅ | ✅ | ❌ | `table-bar` |
| Eisenhower | ❌ | ❌ | ❌ | — |
| Dashboard | ✅ | ✅ | ❌ | `dashboard-bar` |
| Habits | ✅ | ✅ | ❌ | `habits-bar` |
| Settings | ✅ (via shell) | ✅ | ❌ | `settings-bar` |

> **Gap:** Eisenhower is the only task page not using UnifiedBar.

### page-shell-controller → Page Controllers

| Controller | Calls `initPageShellNavigation()` | Uses `pageLifecycle` | Shell test exists |
|-----------|----------------------------------|---------------------|-------------------|
| `today-controller.ts` | ✅ | ✅ | ✅ `today-shell.spec.ts` |
| `upcoming-controller.ts` | ✅ | ✅ | ✅ `upcoming-shell.spec.ts` |
| `calendar-controller.ts` | ✅ | ✅ | ✅ `calendar-shell.spec.ts` |
| `kanban-controller.ts` | ✅ | ✅ | ✅ `kanban-shell.spec.ts` |
| `table-controller.ts` | ✅ | ✅ | ✅ `table-shell.spec.ts` |
| `eisenhower-controller.ts` | ❌ | ❌ | ❌ no test |
| `dashboard-controller.ts` | ✅ (own) | ✅ | ✅ `dashboard-shell.spec.ts` |
| `habits-controller.ts` | ✅ (own) | ✅ | ✅ `habits-shell.spec.ts` |

> **Gap:** Eisenhower controller is entirely standalone — 999 lines, no shared infrastructure.

### unified-bar-controller.ts → Consumers

| Consumer | Via |
|----------|-----|
| `page-shell-controller.ts` | `import { initTitleSwitcher, initSearchLauncher, ... }` |
| `dashboard-controller.ts` | direct import |
| `habits-controller.ts` | direct import |
| `settings-shell-controller.ts` | direct import |

> **Wired correctly.** 4 controllers consume unified-bar-controller through proper imports.

### Section Registries

| Registry | Page consumer | Controller consumer | Wired |
|----------|--------------|-------------------|-------|
| `today-registry.ts` | `today.astro` | `today-controller.ts` | ✅ |
| `upcoming-registry.ts` | `upcoming.astro` | `upcoming-controller.ts` | ✅ |
| `calendar-registry.ts` | `calendar.astro` | `calendar-controller.ts` | ✅ |
| `kanban-registry.ts` | `kanban.astro` | `kanban-controller.ts` | ✅ |
| `table-registry.ts` | `table.astro` | `table-controller.ts` | ✅ |
| `dashboard-registry.ts` | `index.astro` | `dashboard-controller.ts` | ✅ |
| `habits-registry.ts` | `habits.astro` | `habits-controller.ts` | ✅ |

> **All wired.** Each registry has exactly 2 consumers.

## Orphaned API Routes (20+)

Routes with zero discovered frontend consumers:

| Route | Possible reason |
|-------|----------------|
| `/api/tasks/[id]/activity` | Feature stub — planned but not wired |
| `/api/tasks/[id]/comments` | Feature stub |
| `/api/tasks/[id]/duplicate` | Feature stub |
| `/api/tasks/[id]/links` | Feature stub |
| `/api/tasks/[id]/time` | Feature stub |
| `/api/tasks/[id]/accept-proposal` | A2A agent workflow route |
| `/api/tasks/[id]/timeline` | Feature stub |
| `/api/tasks/create` | May be consumed via `task-api-client.ts` with dynamic paths |
| `/api/tasks/reorder` | Kanban reorder — may be called dynamically |
| `/api/tasks/proposals` | A2A agent workflow route |
| `/api/integrations/calendar/*` | CalDAV integration routes |
| `/api/integrations/nodered/*` | Node-RED integration (inactive) |
| `/api/integrations/n8n/*` | N8N integration |

> **Note:** Some "orphaned" routes may be consumed via dynamic URL construction in `task-api-client.ts` or from external consumers (HA, vikunja-compat). The API surface is larger than current frontend consumption.

## E2E Flow Verification

### Flow: New Task from Unified Bar
1. ✅ Bar renders `+` button → dispatches `meitheal:new-task` custom event
2. ✅ `NewTaskModal.astro` listens for event → opens modal
3. ✅ Modal submits to `/api/tasks` → task created
4. ⚠️ Modal fire-and-forget: no toast/feedback propagated back to Bar

### Flow: Search from Unified Bar
1. ✅ Bar search icon → dispatches `meitheal:toggle-search`
2. ✅ `SearchHub.astro` / `search-hub-controller.ts` receives event → opens overlay
3. ✅ Search calls `/api/search` → results displayed
4. ✅ Result click navigates to task detail

### Flow: Section Tab Navigation
1. ✅ Tab pills render from registry data
2. ✅ Click → smooth scroll to `#section-id`
3. ✅ Scroll spy updates active tab pill
4. ✅ Section flash animation on arrival

### Flow: Eisenhower Triage
1. ✅ Triage banner → triage overlay opens
2. ✅ Sliders set urgency/importance
3. ✅ Save → PATCH `/api/tasks/[id]`
4. ❌ **No UnifiedBar context** — triage only reachable from Eisenhower's custom header, not from bar

### Flow: Cross-Page Navigation (Title Switcher)
1. ✅ Title clickable → dropdown renders with page list
2. ✅ Click page → navigates to route
3. ⚠️ **No visual affordance** that title is clickable (no chevron, no cursor:pointer indication in non-hover state)

## Auth Protection

Not applicable — Meitheal uses HA ingress authentication, not per-route auth.

## Summary

| Category | Status |
|----------|--------|
| UnifiedBar adoption | **7/8** task-oriented pages (Eisenhower gap) |
| page-shell-controller adoption | **5/6** applicable pages (Eisenhower gap) |
| Section registries | **7/7** fully wired |
| Shell test coverage | **7** spec files exist |
| E2E new-task flow | ✅ Complete |
| E2E search flow | ✅ Complete |
| E2E tab navigation | ✅ Complete |
| Eisenhower isolation | 🔴 **Critical gap** |
| Orphaned API routes | ⚠️ **20+ routes** |
