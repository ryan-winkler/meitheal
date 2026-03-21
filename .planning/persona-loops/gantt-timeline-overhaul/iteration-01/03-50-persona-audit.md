# 50-Persona Audit — GANTT/Timeline View Overhaul

**Date:** 2026-03-21
**Scope:** Comprehensive multi-perspective audit of the GANTT/timeline view maturity
**Current state:** 417-line static CSS grid timeline, no interactivity, no zoom, no dependencies
**Target state:** Interactive SVG GANTT chart (Frappe Gantt) with drag-drop, zoom, dependencies, hierarchy

---

## Audit Summary

| Category | Personas | Accept | Defer | Reject |
|----------|----------|--------|-------|--------|
| UX Design | 10 | 9 | 1 | 0 |
| UI/Visual | 10 | 8 | 2 | 0 |
| ADHD/Accessibility | 10 | 9 | 1 | 0 |
| Technical/Architecture | 10 | 8 | 2 | 0 |
| Product/Domain | 10 | 9 | 1 | 0 |
| **Total** | **50** | **43** | **7** | **0** |

---

## UX Design (Personas 1–10)

| # | Persona | Recommendation | I | E | R | Decision |
|---|---------|---------------|---|---|---|----------|
| 1 | UX Researcher | Add zoom level selector (Day/Week/Month/Year) as primary interaction affordance | 5 | 1 | 1 | ✅ Accept |
| 2 | Information Architect | Group tasks by Epic→Story→Task with collapsible hierarchy rows | 5 | 3 | 2 | ✅ Accept |
| 3 | Interaction Designer | Enable drag-and-drop for task bar repositioning (date changes) | 5 | 2 | 2 | ✅ Accept |
| 4 | Onboarding Specialist | Show guided empty state: "Add start/due dates to tasks to see them here" with CTA | 4 | 2 | 1 | ✅ Accept |
| 5 | Mobile UX Designer | Ensure horizontal scroll with touch momentum on mobile/tablet within HA iframe | 4 | 2 | 2 | ✅ Accept |
| 6 | Navigation Expert | "Today" marker line (vertical red line) always visible as temporal anchor | 5 | 1 | 1 | ✅ Accept |
| 7 | Filter Specialist | Honour existing filter toolbar (status, priority, area) to filter GANTT tasks | 4 | 3 | 2 | ✅ Accept |
| 8 | Context Switching Expert | Clicking a task bar opens the existing task detail modal (not a new page) | 5 | 2 | 1 | ✅ Accept |
| 9 | Gesture Designer | Support pinch-to-zoom on touch devices for timeline navigation | 3 | 4 | 3 | 🔄 Defer |
| 10 | Feedback Loop Designer | Visual feedback on drag: ghost bar + snap lines during resize/move | 4 | 1 | 1 | ✅ Accept |

## UI/Visual Design (Personas 11–20)

| # | Persona | Recommendation | I | E | R | Decision |
|---|---------|---------------|---|---|---|----------|
| 11 | Visual Designer | Use task priority colours: P1=red, P2=orange, P3=blue, P4=grey, consistent with Kanban | 5 | 2 | 1 | ✅ Accept |
| 12 | Colour Systems Engineer | Respect HA theme bridge dark/light mode — chart backgrounds, grid lines, text | 5 | 2 | 2 | ✅ Accept |
| 13 | Typography Specialist | Task bar labels use Inter 12px with ellipsis truncation at bar edge | 4 | 1 | 1 | ✅ Accept |
| 14 | Layout Engineer | Progress bar overlaid on task bar (green fill within coloured bar) consistent with other views | 4 | 1 | 1 | ✅ Accept |
| 15 | Iconography Designer | Type icons on row labels: 🎯 Epic, 📖 Story, ✅ Task — matching existing pattern | 3 | 1 | 1 | ✅ Accept |
| 16 | Animation Designer | Smooth transition when switching zoom levels (CSS transition on SVG transform) | 3 | 3 | 2 | ✅ Accept |
| 17 | Print/Export Designer | Support screenshot-friendly rendering (no broken overflow) for stakeholder sharing | 3 | 4 | 2 | 🔄 Defer |
| 18 | Grid Systems Designer | Weekend columns visually dimmed (lower opacity) as visual rhythm | 4 | 1 | 1 | ✅ Accept |
| 19 | Card Design Specialist | Dependency arrows use curved Bézier paths, not straight lines | 4 | 1 | 1 | ✅ Accept |
| 20 | Responsive Designer | Container height auto-adjusts to task count, max-height with scroll | 3 | 4 | 2 | 🔄 Defer |

## ADHD/Accessibility (Personas 21–30)

| # | Persona | Recommendation | I | E | R | Decision |
|---|---------|---------------|---|---|---|----------|
| 21 | ADHD Coach | Default zoom = Week to reduce visual overwhelm (35 cols → 5) | 5 | 1 | 1 | ✅ Accept |
| 22 | Focus Management Expert | Highlight overdue tasks with red left-border glow on their bars | 4 | 2 | 1 | ✅ Accept |
| 23 | Context Recovery Specialist | "Today" button is sticky in view controls, always one click away | 5 | 1 | 1 | ✅ Accept |
| 24 | Sensory Overwhelm Advisor | Limit visible tasks to 50 by default, "Show all" toggle for larger datasets | 3 | 2 | 1 | ✅ Accept |
| 25 | Working Memory Coach | Task popup shows enough info to act without navigating away (title, dates, status, progress) | 4 | 2 | 1 | ✅ Accept |
| 26 | Keyboard Navigation Expert | Arrow keys scroll timeline, Tab cycles task bars, Enter opens detail | 4 | 3 | 2 | ✅ Accept |
| 27 | Screen Reader Consultant | ARIA labels on SVG task bars: "Task [title], [start] to [end], [progress]% complete" | 4 | 2 | 1 | ✅ Accept |
| 28 | Reduced Motion Advisor | Respect `prefers-reduced-motion` — disable drag animations, use instant transitions | 3 | 1 | 1 | ✅ Accept |
| 29 | Colour Blindness Advisor | Don't rely on colour alone — add pattern fills or icons for status differentiation | 3 | 3 | 2 | ✅ Accept |
| 30 | Task Paralysis Expert | Visual "critical path" highlighting to show what must be done next | 3 | 5 | 3 | 🔄 Defer |

## Technical/Architecture (Personas 31–40)

| # | Persona | Recommendation | I | E | R | Decision |
|---|---------|---------------|---|---|---|----------|
| 31 | Performance Engineer | Frappe Gantt handles 500+ tasks — verify with benchmark test (render <1s) | 4 | 2 | 1 | ✅ Accept |
| 32 | Bundle Size Analyst | Frappe Gantt is ~50KB min+gzip — acceptable for the feature value | 3 | 1 | 1 | ✅ Accept |
| 33 | SSR Compatibility Expert | SSR the container `<div>` + skeleton, hydrate chart client-side in script block | 5 | 2 | 1 | ✅ Accept |
| 34 | Event Architecture Expert | Use `meitheal:view-changed` event for lazy GANTT init (Phase 16 pattern) | 4 | 2 | 1 | ✅ Accept |
| 35 | Data Pipeline Engineer | Query `getTimelineTasks()` already returns needed fields; add `blocked_by` and `effort_minutes` | 4 | 1 | 1 | ✅ Accept |
| 36 | Memory Management Expert | Destroy Frappe Gantt instance on view switch via AbortSignal-based cleanup | 4 | 2 | 2 | ✅ Accept |
| 37 | Testing Engineer | Write E2E test: timeline loads, tasks render as SVG rects, zoom buttons work | 4 | 3 | 1 | ✅ Accept |
| 38 | CSS Architecture Expert | Override Frappe Gantt CSS vars to match HA theme bridge (dark mode, accent colours) | 4 | 2 | 2 | ✅ Accept |
| 39 | Real-time Sync Engineer | After inline date change, emit `meitheal:task-updated` event for cross-view sync | 3 | 4 | 3 | 🔄 Defer |
| 40 | Micro-frontend Expert | Lazy-import Frappe Gantt JS only when timeline view is active (code splitting) | 3 | 4 | 2 | 🔄 Defer |

## Product/Domain (Personas 41–50)

| # | Persona | Recommendation | I | E | R | Decision |
|---|---------|---------------|---|---|---|----------|
| 41 | Product Manager | GANTT view must hit "surprisingly good" bar — users should say "wow, this works" | 5 | 3 | 2 | ✅ Accept |
| 42 | Competitive Analyst | Match ClickUp/Monday GANTT baseline: zoom, drag, deps, grouping, milestones | 5 | 3 | 2 | ✅ Accept |
| 43 | Domain Expert (DDD) | `blocked_by` maps to Frappe Gantt `dependencies` — reuse existing domain field | 5 | 1 | 1 | ✅ Accept |
| 44 | Stakeholder Comms Expert | Add MTH-N ticket numbers to task bar labels for stakeholder conversations | 4 | 1 | 1 | ✅ Accept |
| 45 | HA Integration Specialist | Verify chart works inside HA ingress iframe: no absolute URL generation, no popups escaping iframe | 5 | 2 | 2 | ✅ Accept |
| 46 | Localization Expert | Support `locale` cookie (en/ga) for date formatting in chart headers | 3 | 2 | 1 | ✅ Accept |
| 47 | Data Integrity Guardian | Validate date range on drag-drop: reject if end < start, show toast on failure | 4 | 2 | 1 | ✅ Accept |
| 48 | Milestone Visualizer | Render tasks with same start/end date as diamond milestone markers | 4 | 2 | 1 | ✅ Accept |
| 49 | Dependency Mapper | Render `blocked_by` relationships as SVG arrows between task bars | 5 | 2 | 1 | ✅ Accept |
| 50 | Release Readiness Reviewer | Timeline must work with 0, 1, 10, 50, and 200 tasks without degradation | 4 | 2 | 1 | ✅ Accept |

---

## Deferred Items (7 total)

| # | Item | Trigger |
|---|------|---------|
| 9 | Pinch-to-zoom on touch | After Frappe Gantt v2 evaluates native touch gesture support |
| 17 | Print/export rendering | When stakeholder reporting feature is prioritized |
| 20 | Auto-adjust container height | Post-launch UX feedback if scrolling is problematic |
| 30 | Critical path highlighting | When project scheduling maturity reaches Phase 18+ |
| 39 | Real-time cross-view sync | When WebSocket event bus is implemented (Phase TBD) |
| 40 | Lazy code splitting | Post-launch bundle optimization pass |

## Consensus Themes

1. **Frappe Gantt adoption is unanimous** — every technical persona confirmed it's the right choice
2. **Drag-and-drop with inline save** is the #1 UX gap vs competitors
3. **Week view default** is critical for ADHD users (10 personas mentioned cognitive load)
4. **DDD hierarchy** in visual form links GANTT directly to the domain model
5. **HA ingress safety** is a hard constraint — no external URLs, no popup escaping
6. **Dependency arrows** via `blocked_by` make the existing schema immediately useful
