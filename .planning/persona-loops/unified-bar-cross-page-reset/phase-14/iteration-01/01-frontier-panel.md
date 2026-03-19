# Frontier Panel - Phase 14 Iteration 01

## Objective
Reset and execute the unified bar rollout across Today, Upcoming, Calendar, Kanban, and Table while preserving Home Assistant-native context links, SearchHub, and Assist behavior.

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Add one reset phase before code so route-switch context, section ids, and delivery order are locked in one place | 5 | 2 | 1 | Accept |
| OSS Integrations Specialist | Preserve `TaskViewTabs` as a second row on Calendar, Kanban, and Table instead of merging route changes into shell section tabs | 5 | 2 | 2 | Accept |
| Reliability Engineer | Extract Upcoming and Calendar controllers before any shell migration so listener ownership stays lifecycle-safe | 5 | 3 | 2 | Accept |
| Security Engineer | Keep Assist and SearchHub as the only global launchers and avoid adding new page-local topbar surfaces | 4 | 1 | 1 | Accept |
| Product Architect | Add a `Flow` section to every page so the shell explains cross-page movement, not just chrome placement | 4 | 2 | 1 | Accept |

## Rejected or Deferred

- Rejected: absorb route-level view switching into the primary shell
- Deferred: per-page companion copy/open UI outside Settings
