# Frontier Panel — Habits Shell Rollout Iteration 01

## Recommendations

1. Move habits to the same `UnifiedBar` contract used by Settings and Dashboard so the shell language is actually reusable.
2. Replace the inline script with a lifecycle-safe controller before attempting any further page rollouts.
3. Server-render the first routines payload so the page stays Astro-first and Home Assistant friendly on first load.
4. Fix the template edit path while touching the controller, because losing description/priority on edit is a real quality regression.

## Accepted

All four recommendations were accepted for this iteration.
