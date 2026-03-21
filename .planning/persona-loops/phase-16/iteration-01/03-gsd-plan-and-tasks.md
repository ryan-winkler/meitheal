# GSD Plan and Tasks - Phase 16 Iteration 01

## Objective
Tasks Layout Redesign: Unify 4 task views under single /tasks page with hash-based view switching, Area/Space selector, composable filter row, and Customize panel

## Accepted Recommendations → Tasks

### From Panel 1 (Frontier Experts)

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T1 | Extract each view (Table, Calendar, Timeline) into standalone Astro components with isolated frontmatter data fetching | Platform Architect | `/gsd-execute-phase 16` |
| T2 | Wire `meitheal:view-changed` event using existing `pageLifecycle.onPageLoad(signal)` pattern from Settings shell | OSS Integrations Specialist | `/gsd-execute-phase 16` |
| T3 | Add `data-view-initialized` attribute and `Set<string>` tracking to prevent double-init on rapid view switching | Reliability Engineer | `/gsd-execute-phase 16` |
| T4 | Ensure redirect pages always prefix target with `ingressPath` from `Astro.locals` | Security Engineer | `/gsd-execute-phase 16` |
| T5 | Scope filter state per view in `localStorage` with key `meitheal:tasks-filters-{view}` | Product Architect | `/gsd-execute-phase 16` |

### From Panel 2 (ADHD/Productivity)

| # | Task | Source | GSD Command |
|---|------|--------|-------------|
| T6 | Add keyboard shortcuts `1-4` for view switching (Kanban/Table/Calendar/Timeline) when no input focused | Workflow Coach | `/gsd-execute-phase 16` |
| T7 | Persist and restore scroll position per view using `data-scroll-top` on view containers | Execution Coach | `/gsd-execute-phase 16` |
| T8 | Add ARIA roles: `role="tablist"` on container, `role="tab"` on buttons, `aria-selected` and `aria-label` | Knowledge Coach | `/gsd-execute-phase 16` |
| T9 | Scope Phase 16.1 strictly — only view switching, redirects, and controller. No filter/area/customize changes | Focus Optimizer | `/gsd-execute-phase 16` |
| T10 | Create reusable E2E helper `switchToView(page, view)` for hash navigation + wait pattern | Automation Coach | `/gsd-execute-phase 16` |

## Task Dependencies

```
T1 (extract views) → T2 (lifecycle wiring) → T3 (double-init guard)
T1 → T4 (redirects with ingress prefix)
T2 → T5 (per-view filter state)
T2 → T6 (keyboard shortcuts)
T2 → T7 (scroll persistence)
T2 → T8 (ARIA roles)
T9 constrains ALL tasks (scope guard)
T10 follows T1 + T2 (needs working view switching)
```

## Execution Order

1. T9 (scope discipline — mental guardrail)
2. T1 (extract view components)
3. T4 (redirect pages)
4. T2 + T3 (view controller with init protection)
5. T8 (ARIA roles on view tabs)
6. T5 (per-view filter state)
7. T6 + T7 (keyboard shortcuts + scroll persistence)
8. T10 (E2E test helper)
