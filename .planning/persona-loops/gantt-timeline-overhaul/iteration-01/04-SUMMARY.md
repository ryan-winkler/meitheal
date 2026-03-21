# Research Synthesis — GANTT/Timeline Overhaul

**Date:** 2026-03-21
**Sources:** Phase research, project research, codebase mapping, frontier panel, ADHD panel, 50-persona audit

---

## Decision: Adopt Frappe Gantt

**Unanimous consensus across 50 personas.** Replace the static CSS grid timeline (417 lines, zero interactivity) with Frappe Gantt, a lightweight BSD-licensed SVG charting library.

### Why Frappe Gantt

| Criterion | Frappe Gantt | Hand-rolled | Status quo |
|-----------|-------------|-------------|------------|
| Drag-and-drop | ✅ Built-in | 3-5 days | ❌ None |
| Dependency arrows | ✅ Built-in | 2-3 days | ❌ None |
| Zoom (Day/Week/Month/Year) | ✅ Built-in | 1-2 days | ❌ Fixed 5-week |
| Progress bars | ✅ Built-in | 1 day | ❌ Text only |
| Custom popups | ✅ Built-in | 1 day | ❌ None |
| Today marker | ✅ Built-in | 0.5 day | ❌ None |
| Holidays/weekends | ✅ Built-in | 1 day | ⚠️ Basic |
| Bundle size | ~50KB gzipped | 0 | 0 |
| License | BSD | N/A | N/A |

### Schema Readiness ✅

All needed data fields already exist in `TaskRow`:
- `start_date`, `end_date` → bar position
- `progress` → progress overlay
- `parent_id` → hierarchy grouping
- `blocked_by` → dependency arrows
- `task_type` → epic/story/task visual differentiation
- `color` → custom bar colours
- `ticket_number` → MTH-N labels

### Integration Approach

1. SSR the container `<div>` with loading skeleton
2. Serialize task data as JSON in a `<script type="application/json">` block
3. Initialize Frappe Gantt client-side via `pageLifecycle.onPageLoad()`
4. Wire event callbacks to PATCH API for inline editing
5. Use AbortSignal for cleanup on navigation

### Key Constraints

- **HA ingress safe:** Chart is pure client-side SVG, no external URLs
- **Astro-native:** No React/Vue islands needed, just `<script>` block
- **DDD hierarchy:** Epic→Story→Task visual grouping with indentation
- **ADHD-first:** Week default, Today button, minimal cognitive load

### Accepted Recommendations (43 from audit)

Priority-ordered task list:

| Priority | Task | Source |
|----------|------|--------|
| P1 | Install Frappe Gantt, create `TasksTimelineView.astro` component | Frontier #1, #2 |
| P1 | Map `TaskRow` fields to Frappe Gantt task format | Domain #43 |
| P1 | Implement drag-and-drop → PATCH API | ADHD #2 |
| P1 | Enable zoom (Day/Week/Month) with Week default | ADHD #4, UX #1 |
| P1 | Add Today button and today marker line | ADHD #1, UX #6 |
| P1 | Render dependency arrows from `blocked_by` | Domain #49, Product #42 |
| P2 | Custom popup with task details | ADHD #3 |
| P2 | DDD hierarchy grouping (Epic→Story→Task) | Frontier #5, UX #2 |
| P2 | Dark/light mode CSS integration (HA theme bridge) | UI #12 |
| P2 | Priority colour coding matching Kanban | UI #11 |
| P2 | Empty-state with CTA | Reliability #3, UX #4 |
| P2 | Loading skeleton | Reliability #3 |
| P3 | localStorage zoom persistence | ADHD #5 |
| P3 | Weekend dimming | UI #18 |
| P3 | MTH-N ticket labels on bars | Product #44 |
| P3 | XSS sanitization for titles | Security #4 |
| P3 | ARIA labels for accessibility | Accessibility #27 |
| P3 | Overdue task red border | ADHD #22 |
| P3 | Filter toolbar integration | UX #7 |
| P3 | Milestone markers (same start/end) | Product #48 |

### Deferred (7 items)

- Pinch-to-zoom, print/export, auto-height, critical path, real-time sync, lazy code splitting, responsive container height
