# Implementation Log — Phase 16 Iteration 02

## Status: Complete

| Task | Command | Status | Outcome |
|------|---------|--------|---------|
| T1: Core Native SVG Renderer | `/gsd-execute-phase 16` | ✅ Done | Rewrote `timeline-controller.ts` (~630 lines) as pure SVG + vanilla JS. Removed `frappe-gantt` dependency. Zero external deps. Uses CSS variables for theming. |
| T2: Fixed Label Sidebar | — | ✅ Done | 200px fixed sidebar with task names, ticket numbers, type dots, overdue/complete visual states. Syncs scroll with chart. |
| T3: Resize Handles | — | ✅ Done | Left/right edge drag handles appear on bar hover, snap to grid, PATCH start/end dates independently. |
| T4: Hover Tooltips | — | ✅ Done | 300ms delay tooltip on bar/milestone hover showing name, dates, status, priority, progress. |
| T5: Scroll-to-Today FAB | — | ✅ Done | Sticky FAB in bottom-right, pulse animation on first load, smooth scroll to today line. |
| T6: Keyboard Shortcuts | — | ✅ Done | `T` scrolls to today. Guards against input field conflicts. |
| T7: Priority Legend | — | ✅ Done | `<details>` disclosure chip in signal bar toolbar. Shows Priority (P1-P4), Type (Epic/Story/Milestone), State (Overdue/Complete). |
| T8: Overdue Visual Markers | — | ✅ Done | Red border accent around overdue bars, red text in sidebar, glow on type dot. |
| T9: Scroll Position Persistence | — | ✅ Done | `localStorage` keyed by zoom level. Restores on view re-enter. |
| T10: Milestone Markers | — | ✅ Done | Diamond SVG polygons for zero-duration tasks. Click/hover interactive. ARIA labelled. |

## Files Changed

| File | Change |
|------|--------|
| `apps/web/src/lib/timeline-controller.ts` | Complete rewrite — native SVG GANTT renderer |
| `apps/web/src/components/views/TasksTimelineView.astro` | Updated toolbar (zoom select, legend), removed Frappe Gantt refs |
| `apps/web/src/styles/timeline-gantt.css` | Replaced vendored Frappe CSS with native GANTT styles |
| `apps/web/src/types/frappe-gantt.d.ts` | Deleted |
| `apps/web/package.json` | Removed `frappe-gantt` dependency |

## Verification

- `astro check` — 0 errors from timeline files (only pre-existing `projects/[id].astro` errors)
- Browser tested: Day/Week zoom switching, legend, sidebar, milestones, today indicator, FAB
- Dev server running on port 4322
