# Unified Bar Cross-Page Context Map

> Date: 2026-03-19
> Scope: Today, Upcoming, Calendar, Kanban, Table
> Purpose: lock the page-context links, secondary navigation, and rollout blockers before the shell rewrite

## Direction

1. `UnifiedBar` is the primary shell on every target page.
2. `TaskViewTabs.astro` remains the secondary route-switch strip on Calendar, Kanban, and Table.
3. Today and Upcoming stay single-surface pages with no secondary route strip.
4. Search always launches `SearchHub`; Assist always stays on `ask-ha-btn`.
5. Same-route hash anchors remain the only section-navigation mechanism.

## Page Map

| Page | Unified Bar Tabs | Secondary Context Nav | Shell Actions | Controls Moved Into Sections | Readiness / Blockers |
| --- | --- | --- | --- | --- | --- |
| Today | `today-overview`, `today-focus`, `today-triage`, `today-work`, `today-habits` | None | `Clear Done`, `New Task`, Search, Assist | daily stats, quick add, carried-forward triage, suggested work, habits block | controller already exists; needs shell wiring and section wrappers |
| Upcoming | `upcoming-overview`, `upcoming-next`, `upcoming-week`, `upcoming-flow` | None | `New Task`, Search, Assist | Today/Calendar adjacency links, grouped day cards, quick completion, task handoff | inline scripts must be extracted first |
| Calendar | `calendar-overview`, `calendar-month`, `calendar-agenda`, `calendar-flow` | `TaskViewTabs.astro` | `Sync`, `New Task`, Search, Assist | month controls, task/event summary, day drawer, Today/Upcoming flow links | inline scripts must be extracted first; sync and drawer state must stay intact |
| Kanban | `kanban-overview`, `kanban-lanes`, `kanban-fields`, `kanban-flow` | `TaskViewTabs.astro` | `Manage Lanes`, `New Task`, Search, Assist | card field emphasis, lane explanation, view handoff, filter orientation | controller exists; needs shell wiring, section anchors, and card-field demotion from top action cluster |
| Table | `table-overview`, `table-filters`, `table-fields`, `table-flow` | `TaskViewTabs.astro` | `New Task`, Search, Assist | filters, presets, column customizer, cross-view handoff | controller exists; needs shell wiring and section anchors |

## Ranked Migration Decisions

### What becomes unified-bar tabs

1. Page-local overview / orientation
2. The page's primary work mode sections
3. Flow / cross-page handoff
4. Lanes / fields / filters sections where the page has dense configuration

### What stays secondary context navigation

1. Route-level task-view switching on Calendar, Kanban, and Table
2. Query-preserving view handoff to Gantt from existing shared route tabs
3. Month navigation controls on Calendar

### What stays in the shell action area

1. Global search launcher
2. Assist button
3. Primary create action (`New Task`)
4. Page-critical, route-scoped actions: `Clear Done`, `Sync`, `Manage Lanes`

### What moves into anchored sections

1. Card / field customization emphasis on Kanban and Table
2. Saved filter presets and column controls on Table
3. Day-group orientation and Today/Calendar adjacency on Upcoming
4. Month summary and cross-page flow links on Calendar

## Readiness Ranking

1. Today: lowest implementation risk, controller already extracted
2. Upcoming: medium risk, compact page but needs controller extraction
3. Calendar: medium-high risk, larger inline script and HA sync affordances
4. Kanban: high UX density, needs shell without flattening lanes and fields
5. Table: high UX density, needs shell without crowding filters and columns

## Rollout Order

1. Today
2. Upcoming
3. Calendar
4. Kanban
5. Table

## Non-Negotiables

1. No page-local search bars or alternate Assist entry points.
2. No bare-route redirects or non-hash in-page movement.
3. No breakage of task-detail handoff, query-preserving view switches, or HA ingress-safe paths.
4. No DDD leakage between page shell work and domain mutations.
