# Frontier Panel - Phase 16 Iteration 01

## Objective
Tasks Layout Redesign: Unify 4 task views under single /tasks page with hash-based view switching, Area/Space selector, composable filter row, and Customize panel

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Extract each view into its own Astro component (`TasksTableView.astro`, etc.) with isolated frontmatter data fetching, rather than inlining all 4 views' markup in tasks.astro. This keeps bounded context separation clean and prevents a 3000+ LoC monolith. Each component owns its SSR lifecycle independently. Success: No view component imports from another view's internals. | 5 | 3 | 2 | Accept |
| OSS Integrations Specialist | Reuse the existing `pageLifecycle.onPageLoad(signal)` + custom event pattern from Settings shell rather than building a new lifecycle system. Wire `meitheal:view-changed` event to let each view's controller lazy-init on first display. No new dependencies needed — this is all native Astro `<script>` + Web APIs. Success: View switch has 0 loading spinners and 0 page reloads. | 4 | 2 | 1 | Accept |
| Reliability Engineer | Add a `data-view-initialized` attribute to each view container and guard against double-initialization in the view controller. Track initialized views in a `Set<string>` to prevent duplicate event listeners on rapid view switching. Success: Console shows exactly 1 init log per view regardless of how many times user switches. | 4 | 1 | 2 | Accept |
| Security Engineer | Ensure the redirect pages (table.astro, calendar.astro, timeline.astro) always prefix with `ingressPath` from `Astro.locals` to prevent redirect-to-external attacks. The hash fragment is client-only so it can't be manipulated server-side, but the redirect target must be same-origin. Success: Redirect targets always start with `ingressPath || ""` + `/tasks`. | 3 | 1 | 1 | Accept |
| Product Architect | Preserve filter state in `localStorage` scoped per view (key: `meitheal:tasks-filters-{view}`) rather than globally. Users expect Table grouped by priority and Kanban grouped by status simultaneously. Success: Switching from Kanban (grouped by type) to Table shows Table's own last-used grouping, not Kanban's. | 5 | 2 | 2 | Accept |

## Rejected or Deferred

- (none — all recommendations are high-impact, low-effort and concrete)
