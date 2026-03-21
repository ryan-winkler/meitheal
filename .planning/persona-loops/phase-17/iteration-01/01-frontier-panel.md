# Frontier Panel - Phase 17 Iteration 01

## Objective
Introduce Pillars domain — permanent motivational anchors (the WHY layer) — as a new bounded context in Meitheal

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Use a M2M join table (`pillar_associations`) with FK CASCADE instead of adding `pillar_id` FK to every entity table. This keeps the Pillars bounded context isolated — it owns its own association data, and no existing domain tables (tasks, goals, routines) need schema changes. Success: Pillars domain can be deleted without touching any other migration. | 5 | 2 | 1 | Accept |
| OSS Integrations Specialist | Follow the existing `domains/habits/habit-service.ts` pattern exactly — single file with `ensureSchema()`, CRUD functions, and `resetForTests()`. No new ORM abstractions, no new packages. The pattern is proven across habits, labels, and gamification domains. Success: New domain under `domains/pillars/` with zero new dependencies. | 4 | 2 | 1 | Accept |
| Reliability Engineer | Add `CREATE INDEX IF NOT EXISTS pillar_associations_entity_idx ON pillar_associations(entity_type, entity_id)` for reverse lookups and `pillars_active_idx ON pillars(is_active)` for filtered queries. Without indexes, `getPillarsForEntity()` becomes O(n) table scan on the join table. Success: EXPLAIN QUERY PLAN shows index usage for both forward and reverse association queries. | 4 | 1 | 1 | Accept |
| Security Engineer | Validate `entity_type` against a whitelist constant (`VALID_PILLAR_ENTITY_TYPES = ["goal", "routine", "task"]`) in the service layer before any INSERT into `pillar_associations`. Without validation, arbitrary entity types can be injected via API. Success: `linkEntity("pillar-1", "admin_secret", "xss")` throws validation error. | 5 | 1 | 1 | Accept |
| Product Architect | Enforce strict ubiquitous language: the domain term is "Pillar" everywhere — code, UI, API, docs, variable names. Never "value", "principle", or "life-pillar". Add the definition to `docs/kcs/hierarchy-glossary.md`. Success: `grep -r "value" apps/web/src/domains/pillars/` returns zero results where "Pillar" was intended. | 4 | 1 | 1 | Accept |

## Rejected or Deferred

- (none — all recommendations are high-impact, low-effort, low-risk)
