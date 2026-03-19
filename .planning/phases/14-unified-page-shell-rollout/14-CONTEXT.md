# Phase 14 Context: Unified Page Shell Rollout

## Domain Boundary

This phase standardizes how Meitheal pages expose page-level navigation, search launch, and high-value actions inside Home Assistant. It does not redefine the dashboard or habits domain models.

## Decisions

1. Start with the dashboard (`/`) as the proving ground for the cross-page shell pattern.
2. Reuse `UnifiedBar` and the global `SearchHub` launcher instead of page-local inline search surfaces.
3. Keep section navigation hash-based on the same page so links remain ingress-safe inside Home Assistant.
4. Extract or formalize shared bar behavior where needed instead of copying settings-specific controller code into more pages.
5. Preserve existing dashboard data loading, quick-add semantics, and task-detail modal behavior during the shell migration.

## Claude's Discretion

1. Final dashboard section taxonomy, copy, and visual grouping.
2. Whether the reusable shell behavior lives in the dashboard controller or a shared helper module, as long as it is ready for the habits follow-up.
3. The minimum dashboard controller cleanup needed to align with `pageLifecycle` and Astro page bootstrapping conventions.

## Deferred Ideas

1. Full habits page controller extraction out of the current inline script.
2. Applying the new shell to Today, Upcoming, Calendar, Kanban, and Table before the dashboard-first pattern is proven.
3. A broader theme-token alignment pass beyond the existing HA theme bridge.
