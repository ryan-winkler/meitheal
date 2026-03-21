# GSD Plan and Tasks - Phase 17 Iteration 02

## Objective
Pillars + Principles domain (expanded): service, API, North Star UX, AI integration, strategic evaluator, conflict resolution

## Source Traceability

All tasks derived from accepted recommendations in iteration 02 panels.

## Synthesized Tasks

### Sub-Phase 17A: Core Domain (Foundation)

| # | Task | Source | GSD Command | Depends On |
|---|------|--------|-------------|------------|
| T1 | Split `pillar-service.ts` into 3 files: `pillar-service.ts` (Pillar CRUD), `principle-service.ts` (Principle CRUD), `pillar-association-service.ts` (linking/inheritance) — no file exceeds 200 LoC | Frontier: Platform Architect | execute-phase | — |
| T2 | Implement idempotent ALTER TABLE migration in `ensurePillarSchema()` — add `pillar_id TEXT` column to `goals`, `tasks`, `task_templates` with try/catch for duplicate column | Frontier: Reliability Engineer | execute-phase | T1 |
| T3 | Add input validation to all API routes: `weight` 1-10, `entityType` enum, `isNonNegotiable` boolean coercion, no raw SQL error leaks | Frontier: Security Engineer | execute-phase | T1 |
| T4 | Create REST API routes: `/api/pillars` (list/create), `/api/pillars/[id]` (get/patch/delete), `/api/pillars/[id]/principles` (CRUD), `/api/pillars/[id]/associations` (link/unlink) | execute-phase | T1, T2 |
| T5 | Update `AGENTS.md` DDD Context Boundaries table with `domains/pillars/` entry | ADHD: Knowledge Coach | execute-phase | T1 |
| T6 | Update `hierarchy-glossary.md` with Principle, Manifesto, Non-Negotiable, Weight definitions | ADHD: Knowledge Coach | execute-phase | T1 |
| T7 | Update `README.md` feature list with Pillars domain description | ADHD: Knowledge Coach | execute-phase | T1 |
| T8 | Update Memory knowledge graph with Pillars domain entities and relationships | ADHD: Knowledge Coach | execute-phase | T1 |
| T9 | Update `adr-017-pillars-domain.md` to include Principles, AI integration, strategic evaluator decisions | execute-phase | T1 |
| T10 | Write E2E tests for 17A: Pillar CRUD, Principle CRUD, associations, ALTER TABLE migration | verify-phase | T1-T4 |

### Sub-Phase 17B: North Star UX + Linking

| # | Task | Source | GSD Command | Depends On |
|---|------|--------|-------------|------------|
| T11 | Create `PillarCard.astro` — manifesto text as hero element (large, readable), icon+color as accent, Pillar name secondary | ADHD: Focus Optimizer | execute-phase | T4 |
| T12 | Create North Star masonry page (`pillars.astro`) — CSS Grid, responsive, empty state shows AI wizard prompt | execute-phase | T11 |
| T13 | Create `PillarDetail.astro` — Blueprint view: WHY (manifesto), Principles list, linked Goals/Routines/Tasks | execute-phase | T11 |
| T14 | Create `PrincipleList.astro` — list items with Non-Negotiable badge, add/edit/delete inline | execute-phase | T4 |
| T15 | Create `PillarSelector.astro` — dropdown for Goal/Routine create modals | execute-phase | T4 |
| T16 | Add "Unaligned" visual flag on tasks without Pillar (inherited or direct) — neutral tone, not shame | execute-phase | T4 |
| T17 | Add Pillars link/section to `progress.astro` sidebar navigation | execute-phase | T12 |
| T18 | Enforce sub-phase boundary: 17B tests pass before 17C starts | Frontier: Product Architect | verify-phase | T11-T17 |

### Sub-Phase 17C: Intelligence Layer

| # | Task | Source | GSD Command | Depends On |
|---|------|--------|-------------|------------|
| T19 | Create `fetchPillarContext()` in `ai-context-service.ts` — fetch Non-Negotiable Principles, format as numbered guardrails, cap at 15 items | Frontier: OSS Integrations Specialist | execute-phase | T4 |
| T20 | Add Pillar-weight pre-computation step in `rule-resolver.ts` — additive boost, configurable factor, not multiplicative | execute-phase | T4 |
| T21 | Show transparent "Pillar boost: +N" indicator on task list when weight contributed to sort | ADHD: Automation Coach | execute-phase | T20 |
| T22 | Implement conflict resolution toast: Pillar icon + "This overlaps with [Principle]. Reschedule?" — dismissible, logged, NEVER modal | ADHD: Execution Coach | execute-phase | T19 |
| T23 | Build AI onboarding wizard: 3-question conversational flow → AI drafts 3-5 Pillars with Principles → user edits | ADHD: Workflow Coach | execute-phase | T4, T19 |
| T24 | Add alignment audit chart to `progress.astro` — weekly balance across Pillars with imbalance warnings | execute-phase | T4 |
| T25 | Write E2E tests for 17C: AI context injection, boost calculation, conflict detection | verify-phase | T19-T24 |

## Wave Structure

```
Wave 1 (17A): T1-T10 — Core service, API, schema, docs, E2E
Wave 2 (17B): T11-T18 — North Star UX, cards, selectors, linking
Wave 3 (17C): T19-T25 — AI, strategy, conflicts, onboarding, audit
```

## Summary

- **25 total tasks** across 3 sub-phases
- **10 frontier-sourced** (5 from Panel 1, 5 synthesized)
- **10 ADHD-sourced** (5 from Panel 2, 5 synthesized)
- **5 derived** from sub-phase structure
- All recommendations **accepted** (0 deferred, 0 rejected)
