# Unified Bar Cross-Page Consolidated Report

> Date: 2026-03-19
> Inputs: current Settings, Dashboard, Habits shells; page code audit; 50-persona review; Home Assistant companion guidance

## Outcome

The best direction is a shared `UnifiedBar` program with page-specific section registries, controller-backed hash navigation, and a preserved secondary route-switch strip only where the user is changing task views rather than moving within a page.

## Final Decisions

1. `UnifiedBar` becomes the canonical top shell on Today, Upcoming, Calendar, Kanban, and Table.
2. `TaskViewTabs.astro` stays on Calendar, Kanban, and Table as a secondary route-switch strip.
3. Today and Upcoming stay one-layer surfaces.
4. Search and Assist remain global.
5. Flow sections are mandatory on every page so the shell explains handoff instead of acting like isolated chrome.

## Ranked Action Model

### What becomes tabs

1. Overview
2. The page's primary work sections
3. Flow
4. Lanes / Filters / Fields when the page is configuration-dense

### What stays out of tabs

1. Route-level task-view switching
2. Month prev/next controls
3. Dense filter widgets and customizer controls
4. Day-group accordions

### What remains shell actions

1. Search
2. Assist
3. New Task
4. `Clear Done`
5. `Sync`
6. `Manage Lanes`

## Readiness And Risk

| Page | Readiness | Risk | Why |
| --- | --- | --- | --- |
| Today | High | Low | controller already extracted; existing sections map cleanly |
| Upcoming | Medium | Medium | small page, but still inline-script owned |
| Calendar | Medium | Medium-high | inline script plus sync and day drawer behavior |
| Kanban | Medium | High | dense toolbar and lane/field context cannot be flattened |
| Table | Medium | High | dense filters and fields need careful section placement |

## Recommended Rollout

1. Today
2. Upcoming
3. Calendar
4. Kanban
5. Table

## Planning Implications

1. Add a reset phase (`14.2`) for audit, synthesis, persona-loop, and backlog alignment.
2. Create one delivery phase per page (`14.3` through `14.7`).
3. Record the persona-loop tooling mismatch: the installed generator only supports integer phases, so the loop is tracked under a `phase-14` bucket inside a named output directory.
4. Keep Tier 2 Home Assistant verification as the program closeout gate, even though most individual page changes are Tier 1 code changes.
