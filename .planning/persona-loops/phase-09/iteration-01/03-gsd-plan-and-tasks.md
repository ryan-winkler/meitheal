# GSD Plan and Tasks - Phase 09 Iteration 01

## Objective
Implement a universal search hub without breaking Home Assistant ingress behavior or duplicating search logic.

## Synthesized Tasks

| # | Task | Source | GSD Command | Priority |
|---|---|---|---|---|
| 1 | Create a dedicated search domain plus `/api/search` universal contract | Domain Reviewer | `/gsd-execute-phase 09` | P1 |
| 2 | Upgrade repository-backed task search for IDs, labels, custom fields, comments, and completed/archive toggles | Product Architect | `/gsd-execute-phase 09` | P1 |
| 3 | Build a shared Astro search overlay/controller and rewire topbar + keyboard launch | Astro Native Reviewer | `/gsd-execute-phase 09` | P1 |
| 4 | Reuse boards, saved filters, and settings registry data as search sources | Workflow Coach | `/gsd-execute-phase 09` | P1 |
| 5 | Unify HA service, LLM API, and MCP task search on the same backend path | HA UX Reviewer | `/gsd-execute-phase 09` | P1 |
| 6 | Add browser coverage plus KCS/public contract updates | Knowledge Coach | `/gsd-execute-phase 09` | P1 |
| 7 | Attempt Tier 2 HA devcontainer verification | AGENTS verification policy | `/gsd-execute-phase 09` | P1 |

## Execution Order
- Wave 1: backend search contract + task repository upgrade
- Wave 2: shared search hub UI + launcher rewiring
- Wave 3: HA parity, docs, and browser verification
- Wave 4: Tier 2 verification attempt
