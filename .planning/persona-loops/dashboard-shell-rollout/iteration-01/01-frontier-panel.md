# Frontier Panel — Dashboard Shell Rollout Iteration 01

## Objective

Determine the strongest architecture and UX path for applying the mature Settings shell language to the dashboard first without breaking Astro-first, Home Assistant-first behavior.

| Recommendation | Impact | Effort | Risk | Decision | Notes |
|---|---:|---:|---:|---|---|
| Reuse `UnifiedBar` and hash-linked sections on the dashboard instead of inventing a second shell | 5 | 2 | 2 | Accept | Matches the mature Settings pattern and keeps ingress-safe deep links |
| Extract reusable bar helpers for switcher/search/new-task/tab-overflow behaviors | 5 | 3 | 2 | Accept | Prevents settings-only controller drift as more pages adopt the shell |
| Treat habits as the next rollout page, not part of the first implementation slice | 4 | 1 | 1 | Accept | Habits still needs controller extraction and lifecycle cleanup |
| Replace SearchHub with a dashboard-local search input | 2 | 3 | 4 | Reject | Violates the existing search unification direction and duplicates UX |

## Accepted Direction

1. Dashboard-first rollout with the same top-level shell language as Settings.
2. Shared bar behavior where it is already proven and low-risk.
3. Habits documented as the next page once the dashboard pattern is stable.
