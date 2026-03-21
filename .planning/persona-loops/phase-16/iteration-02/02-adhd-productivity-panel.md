# ADHD / Productivity Panel — Phase 16 Iteration 02

## Objective
Ensure the native GANTT/Timeline view serves ADHD brains and productivity-focused users by reducing cognitive load, supporting fast capture, and providing immediate visual feedback.

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Workflow Coach | Add a "Scroll to Today" floating action button (FAB) in the bottom-right corner of the GANTT wrapper. Users with ADHD lose spatial context when scrolling — a one-tap anchor point to "now" is essential. Style with `position: sticky; bottom: 12px; right: 12px` and a pulse animation on first load. Success: Button is visible in all scroll positions and smoothly scrolls to today marker. | 5 | 1 | 1 | Accept |
| Execution Coach | Wire the existing keyboard shortcut system so `N` opens the quick-capture task modal pre-populated with the current date range visible on screen, and `T` scrolls to today. These zero-click shortcuts prevent ADHD users from losing context. Success: Pressing `T` anywhere on timeline view scrolls to today. Pressing `N` opens new task modal. | 4 | 2 | 1 | Accept |
| Knowledge Coach | Show a visual legend in the timeline toolbar that maps bar colours to priority levels (P1 red → P4 grey) and shows type indicators (bold top = epic, line = story, plain = task). Without this, the colour system is a black box. Success: A collapsible "Legend" chip in the toolbar expands to show all colour/shape meanings. | 3 | 2 | 1 | Accept |
| Focus Optimizer | Add "overdue" visual markers — task bars that end before today but aren't complete should show a red left-border accent and a subtle warning glow. ADHD brains respond to urgency cues, and overdue items must be visually distinct from completed or future items. No notification noise — just passive visual weight. Success: Overdue tasks have a distinct red accent regardless of priority colour. | 5 | 2 | 1 | Accept |
| Automation Coach | Persist the scroll position per zoom level in localStorage alongside the zoom preference. When switching between views and returning to timeline, restore exact scroll position. ADHD users frequently tab-switch and lose their place. Success: Switching to Kanban and back to Timeline preserves horizontal scroll offset. | 4 | 1 | 1 | Accept |

## Rejected or Deferred
- (none — all recommendations are high-impact, low-effort and concrete)
