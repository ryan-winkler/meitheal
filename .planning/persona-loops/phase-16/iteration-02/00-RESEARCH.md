# GANTT Timeline Research — Phase 16 Iteration 02

## Objective
Build a mature, native SVG GANTT/Timeline view for Meitheal that matches the quality bar of ClickUp, Asana, and Notion timelines while staying Astro-native, HA-native, and dependency-free.

## Competitive Analysis

### Feature Matrix — Industry Best Practices

| Feature | ClickUp | Asana | Notion | Linear | Meitheal (Target) |
|---------|---------|-------|--------|--------|-------------------|
| **Drag-and-drop scheduling** | ✅ | ✅ | ✅ | ✅ (projects) | ✅ |
| **Task dependencies (FS/SS/FF/SF)** | ✅ | ✅ | ✅ | ❌ | ✅ (FS only) |
| **Dependency arrows** | ✅ | ✅ | ✅ | ❌ | ✅ |
| **Auto-reschedule dependents** | ✅ | ❌ | ❌ | ❌ | Defer |
| **Progress bars** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Milestone markers** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Today indicator** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Zoom levels (Day/Week/Month)** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Weekend highlighting** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **Row click → detail popup** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Subtask nesting/collapse** | ✅ | ✅ | ✅ | ❌ | Defer (v2) |
| **Priority colouring** | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Type indicators (epic/story/task)** | ✅ | ❌ | ❌ | ✅ | ✅ |
| **Filter by area/assignee** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Keyboard navigation** | ✅ | ✅ | ❌ | ✅ | ✅ |
| **Dark mode theming** | ✅ | ❌ | ✅ | ✅ | ✅ (HA native) |
| **Export/print** | ✅ | ✅ | ❌ | ❌ | Defer |
| **Critical path** | ✅ | ❌ | ❌ | ❌ | Defer |
| **Scroll-to-today** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Resize handles** | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Task label sidebar** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Completed task strikethrough** | ❌ | ❌ | ❌ | ❌ | ✅ (unique) |
| **Hover tooltip** | ✅ | ❌ | ✅ | ❌ | ✅ |

## Must-Have Features (Launch Bar)

1. **Horizontal scrolling SVG grid** with day/week/month columns
2. **Task bars** — positioned by start/end date, coloured by priority
3. **TODAY marker** — vertical line with icon, auto-scroll on load
4. **Zoom controls** — Day/Week/Month selector with localStorage persistence
5. **Drag-and-drop** — move bars to change dates (PATCH /api/tasks/{id})
6. **Resize handles** — drag bar edges to change start/end independently
7. **Progress overlay** — filled portion shows % complete
8. **Click popup** — shows task details, status, dates, progress, "View Details" link
9. **Dependency arrows** — bezier curves between connected tasks
10. **Row labels sidebar** — task name + ticket number, fixed left column
11. **Type indicators** — visual differentiation for epic/story/task
12. **Completed state** — reduced opacity + strikethrough label
13. **Weekend highlighting** — subtle background on Sat/Sun (Day zoom)
14. **Dark mode** — uses Meitheal CSS variables (`--bg-card`, `--text-primary`, etc.)
15. **Empty state** — friendly illustration when no tasks have dates
16. **Area/filter integration** — respects task view filter controls
17. **Milestone markers** — diamond shape for zero-duration milestones
18. **Hover tooltip** — shows dates and status on hover (before click)
19. **Keyboard accessibility** — Tab/arrow navigation, Enter to open popup

## Architecture Decision

**Native SVG over third-party library** (Frappe Gantt removed):
- Full control over HA theme variables
- No CSS pipeline conflicts with Astro
- Zero bundle size overhead
- Ingress-safe (no external resources)
- Can evolve independently

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Performance with 500+ tasks | Virtual rendering — only draw visible rows |
| Drag precision | Snap-to-grid by zoom unit (day/week) |
| SVG accessibility | ARIA roles on bars, keyboard trap on popup |
| HA ingress compatibility | All rendering is client-side SVG, no remote assets |
