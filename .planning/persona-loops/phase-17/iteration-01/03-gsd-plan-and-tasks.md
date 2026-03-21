# GSD Plan & Tasks - Phase 17 Iteration 01

## Objective
Introduce Pillars domain — permanent motivational anchors (the WHY layer) — as a new bounded context in Meitheal

## Accepted Recommendations → Tasks

### From Panel 1: Frontier Experts

| # | Task | Source | GSD Command | Status |
|---|------|--------|-------------|--------|
| T1 | Create `domains/pillars/pillar-service.ts` with `pillar_associations` M2M join table (FK CASCADE), `ensureSchema()`, CRUD functions, and `resetForTests()` following `habit-service.ts` pattern | Platform Architect + OSS Integrations | `/gsd-execute-phase 17` | Open |
| T2 | Add indexes: `pillar_associations_entity_idx(entity_type, entity_id)`, `pillar_associations_pillar_idx(pillar_id)`, `pillars_active_idx(is_active)`, `pillars_position_idx(position)` | Reliability Engineer | `/gsd-execute-phase 17` | Open |
| T3 | Add `VALID_PILLAR_ENTITY_TYPES` whitelist constant and validate `entityType` in `linkEntity()` before INSERT | Security Engineer | `/gsd-execute-phase 17` | Open |
| T4 | Add "Pillar" definition to `docs/kcs/hierarchy-glossary.md` and enforce ubiquitous language | Product Architect | `/gsd-execute-phase 17` | Open |

### From Panel 2: ADHD/Productivity

| # | Task | Source | GSD Command | Status |
|---|------|--------|-------------|--------|
| T5 | Add `habits-pillars` section to `habits-registry.ts` and render Pillars section on `/habits` page | Workflow Coach | `/gsd-execute-phase 17` | Open |
| T6 | Implement soft max-7 Pillar limit with inline warning banner at creation time | Execution Coach | `/gsd-execute-phase 17` | Open |
| T7 | Write ADR-017 documenting naming decision, domain separation, and shame-free UX constraint | Knowledge Coach | `/gsd-execute-phase 17` | Open |
| T8 | Guard V1 scope: CRUD + goal/routine linkage + habits page section ONLY. Defer task linkage, filter chips, analytics, HA sensors. | Focus Optimizer | `/gsd-execute-phase 17` | Open |
| T9 | Pre-fill Pillar description field with "I am someone who..." placeholder text | Automation Coach | `/gsd-execute-phase 17` | Open |

### Additional Tasks (derived from research)

| # | Task | Source | GSD Command | Status |
|---|------|--------|-------------|--------|
| T10 | Create API routes: `GET/POST /api/pillars`, `GET/PATCH/DELETE /api/pillars/[id]`, `POST/DELETE /api/pillars/[id]/associations` | ARCHITECTURE.md | `/gsd-execute-phase 17` | Open |
| T11 | Create UI components: `PillarCard.astro`, `PillarSelector.astro`, `PillarCreateModal.astro` | FEATURES.md | `/gsd-execute-phase 17` | Open |
| T12 | Create `pillars-controller.ts` client-side controller for CRUD and modal management | ARCHITECTURE.md | `/gsd-execute-phase 17` | Open |
| T13 | Write e2e tests: `pillars-crud.spec.ts` with CRUD, association, and cascade tests | PITFALLS.md | `/gsd-execute-phase 17` | Open |
| T14 | Add Pillar type definitions to `domain-model.ts` | ARCHITECTURE.md | `/gsd-execute-phase 17` | Open |

## Task Dependencies

```
T1 (service) ← T2 (indexes), T3 (validation) — can be combined
T1 → T10 (API routes) → T11 (UI components) → T12 (controller)
T5 (registry) → T11 (components)
T7 (ADR) — independent, can be done in parallel
T13 (tests) — depends on T1, T10
T14 (types) — independent, can be done in parallel with T1
```

## Wave Structure

| Wave | Tasks | What it builds |
|------|-------|----------------|
| 1 | T1, T2, T3, T4, T7, T14 | Domain service, schema, types, ADR, glossary |
| 2 | T10 | API routes consuming the service |
| 3 | T5, T6, T9, T11, T12 | UI: registry, components, controller, page section |
| 4 | T8, T13 | Scope guard verification + E2E tests |
