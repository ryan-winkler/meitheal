# Frontier Panel — Phase 16 Iteration 02

## Objective
Native SVG GANTT/Timeline rebuild — replace Frappe Gantt with Astro-native, HA-native, dependency-free GANTT component achieving feature parity with ClickUp/Asana timeline views.

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Add a fixed-position task label sidebar (left column, ~200px) that stays pinned during horizontal scroll. Render it as a separate HTML `<div>` overlaying the SVG left edge with `position: sticky; left: 0`. Each row shows ticket number + task name, aligned to the SVG row grid. This is the #1 feature gap vs ClickUp/Asana and makes the chart usable for >5 tasks. Success: Task names remain visible regardless of horizontal scroll position. | 5 | 3 | 2 | Accept |
| OSS Integrations Specialist | Use the existing Meitheal CSS variable system (`--bg-card`, `--text-primary`, `--accent`, `--border`) for ALL GANTT colours instead of hardcoded hex values. Map HA theme bridge variables for automatic dark/light mode support. Zero new dependencies. Success: GANTT chart automatically adapts when HA theme changes, no custom dark mode CSS needed. | 5 | 2 | 1 | Accept |
| Reliability Engineer | Add resize handles (left/right edges of each bar) that allow users to independently change start/end dates by dragging. Snap to grid at the current zoom level's unit (day/week/month). Show a subtle tooltip with the new date during drag. This prevents the common user error of dragging the whole bar when intending to extend only the end date. Success: Resizing a bar's right edge only changes end_date, not start_date. | 4 | 3 | 2 | Accept |
| Security Engineer | Sanitize all task title text before injecting into SVG `<text>` elements to prevent XSS via crafted task titles. Use `textContent` assignment (not `innerHTML`) for all SVG text nodes. Ensure popup HTML is built via DOM APIs, not string concatenation with unsanitized data. Success: A task titled `<script>alert(1)</script>` renders as literal text, not executable. | 5 | 1 | 1 | Accept |
| Product Architect | Add hover tooltips on bars that show task name, dates, status, and priority BEFORE requiring a click. Use a lightweight `<div>` positioned near cursor on `mouseenter`. This reduces ADHD cognitive load — users can scan quickly without committing to a click. ClickUp and Notion both have this. Success: Hovering over any bar for 300ms shows a tooltip with task metadata. | 4 | 2 | 1 | Accept |

## Rejected or Deferred
- (none — all recommendations are high-impact, low-effort and concrete)
