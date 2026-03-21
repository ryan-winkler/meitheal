# GSD Plan and Tasks - Phase 16 Iteration 04

## Accepted Recommendations to Tasks

1. **Task**: Fix Dropdown Memory Leaks in Gantt Chart
   - **Source**: Frontier Panel (Reliability Engineer), ADHD Panel (Workflow Coach)
   - **Details**: The `colMenuBtn` and `addColBtn` leave orphaned `document.addEventListener("click")` event handlers whenever a menu is closed by clicking the trigger button again. Consolidate their dropdown creation into a shared helper to prevent code duplication, sanitize icon injection, and guarantee clean event unbinding.
   - **Command Map**: `/gsd-execute-phase` -> Implement fixes in `timeline-controller.ts`.
