# ADHD/Productivity Panel - Phase 17 Iteration 01

## Objective
Introduce Pillars domain — permanent motivational anchors (the WHY layer) — as a new bounded context in Meitheal

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Workflow Coach | Surface Pillars under the existing `/habits` page as a new UnifiedBar section (`habits-pillars`) rather than creating a separate `/pillars` route. This reduces navigation cognitive load — users already associate Progress & Growth with identity-level concepts. Success: User navigates to `/habits#habits-pillars` and sees their Pillars without leaving the existing page shell. | 5 | 2 | 1 | Accept |
| Execution Coach | Cap active Pillars at 7 with a soft-limit warning at creation time ("Research shows 3-5 Pillars is optimal"). ADHD users will hyperfocus on setup — the guard prevents paralysis-by-excess. No hard block, just a gentle friction point. Success: Creating a 6th Pillar shows an inline warning banner. Creating an 8th is still possible but requires acknowledging the warning. | 5 | 2 | 1 | Accept |
| Knowledge Coach | Write ADR-017 documenting: (a) why "Pillars" was chosen over "Values" (50-persona audit), (b) why Pillars are a separate bounded context from Goals/Lenses/Areas, (c) the shame-free design constraint. Future-me needs this context when deciding whether to add features to Pillars. Success: `docs/decisions/ADR-017-pillars-domain.md` exists and is linked from AGENTS.md DDD Context Boundaries table. | 4 | 2 | 1 | Accept |
| Focus Optimizer | V1 scope must be exactly: Pillar CRUD + goal/routine linkage + habits page section. NO task linkage, NO filter chips, NO analytics, NO HA sensors. These are explicitly V2. Success: No file touches `filter-state.ts`, no new HA sensor code, no analytics calculations in the V1 PR. | 5 | 1 | 1 | Accept |
| Automation Coach | Use identity-framing in the Pillar description field — pre-fill with "I am someone who..." as placeholder text. This subtle prompt shifts the user from prescriptive language ("I must exercise") to identity language ("I am someone who moves their body"), which behavioral psychology shows is more sustainable for habit formation. Success: Pillar create modal has placeholder "I am someone who..." in the description textarea. | 4 | 1 | 1 | Accept |

## Rejected or Deferred

- (none — all recommendations are high-impact, low-effort, low-risk)

## ADHD-Specific Capture/Triage Improvement

The Workflow Coach recommendation (surfacing under `/habits` instead of separate route) directly improves capture and triage by reducing the number of navigation decisions. Users with ADHD benefit from fewer top-level navigation items — adding Pillars as a section within an existing page means zero new navigation entries to learn.
