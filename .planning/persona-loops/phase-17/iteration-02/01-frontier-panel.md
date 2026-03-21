# Frontier Panel - Phase 17 Iteration 02

## Objective
Pillars + Principles domain (expanded): service, API, North Star UX, AI integration, strategic evaluator, conflict resolution

| Persona | Recommendation | Impact (1-5) | Effort (1-5) | Risk (1-5) | Decision |
| --- | --- | --- | --- | --- | --- |
| Platform Architect | Split `pillar-service.ts` into 3 service files: `pillar-service.ts` (Pillar CRUD), `principle-service.ts` (Principle CRUD), `pillar-association-service.ts` (linking). Single 400-line file becomes unmaintainable with Principles + associations + inheritance + weight logic. Success: no service file exceeds 200 LoC. | 4 | 3 | 2 | Accept |
| OSS Integrations Specialist | Create `fetchPillarContext()` in `ai-context-service.ts` following the exact `fetchHabitContext()` pattern: fetch Non-Negotiable Principles via `/api/pillars/principles?non_negotiable=true`, format as numbered system prompt guardrails, cap at 15 items. Success: AI prompt includes Principles when HA Assist is connected. | 5 | 3 | 2 | Accept |
| Reliability Engineer | Use idempotent ALTER TABLE migration with error-catching for `pillar_id` column additions on `goals`, `tasks`, `task_templates`. Wrap each ALTER in try/catch that silently handles "duplicate column name" errors. Run migration in `ensurePillarSchema()` alongside CREATE TABLE. Success: fresh DB and existing DB both start cleanly. | 5 | 2 | 3 | Accept |
| Security Engineer | Validate `weight` field (1-10 range), `isNonNegotiable` boolean coercion, and `entityType` enum in API routes. Reject out-of-range values with 400 response. Never expose raw SQL errors in API responses. Success: POST/PATCH with `weight: 99` returns 400; no SQL error leaks in response body. | 4 | 2 | 2 | Accept |
| Product Architect | Enforce sub-phase boundary: 17A (service + API + docs), 17B (North Star UX + linking), 17C (AI + strategy + conflict). Each sub-phase must pass its own E2E tests before the next begins. No UI work starts until API is solid; no AI work starts until UX is solid. Success: each sub-phase has distinct test file and verification step. | 4 | 2 | 1 | Accept |

## Rejected or Deferred

- (none)
