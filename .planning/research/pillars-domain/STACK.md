# Pillars Domain — Stack Research (Expanded Scope)

**Date:** 2026-03-21 (v2 — expanded with Principles, AI, Strategy)
**Researcher:** Antigravity (codebase analysis + integration audit)

## Technology Decisions

### Storage Layer

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| SQLite (existing) | ✅ Use | Consistent with all domain data. Pillar + Principle data is small and relational. |
| Separate DB | ❌ Reject | Unnecessary complexity. |

**Schema additions:**
- `pillars` table — aggregate root (name, icon, color, position, is_active)
- `principles` table — child of Pillar (1:N, pillar_id FK, text, weight, is_active)
- `pillar_associations` — M2M join (pillar_id, entity_type, entity_id)
- Migration via existing `ensureSchema()` pattern (CREATE IF NOT EXISTS)

### Domain Package

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| In-app `domains/pillars/` | ✅ Use | Matches `domains/habits/`, `domains/ai/`. Owns service + types. |
| New package `domain-pillars` | ❌ Defer | Expanded scope is ~500 LoC. Package infra still overhead for V1. Revisit at V2. |

### API Layer

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| `/api/pillars` REST | ✅ Use | CRUD + associations. Follows `/api/habits`, `/api/goals` pattern. |
| `/api/pillars/:id/principles` | ✅ Use | Sub-resource for Principles CRUD. Clean REST hierarchy. |

### AI Integration

| Component | Integration Point | Pattern |
|-----------|-------------------|---------|
| `ai-context-service.ts` | `fetchPillarContext()` | Same as existing `fetchHabitContext()` — fetch active Principles, inject into prompt |
| `callAssist()` prompt | System prompt prefix | Principles formatted as behavioral guardrails |
| HA Assist conversation | `conversation.process` | Already handles multi-turn. No protocol changes needed. |

### Strategic Evaluator

| Component | Integration Point | Pattern |
|-----------|-------------------|---------|
| `rule-resolver.ts` | Pre-computation step | Add `pillarWeight` check before framework scoring |
| `framework-config.ts` | New `pillar-boost` rule type | Configurable weight multiplier per Pillar |
| `today-focus-stack.ts` | Server-side sort | Focus stack ordering affected by boosted priority |
| `StrategicEvaluator.astro` | Display Pillar context | Show which Pillar(s) a task upholds |

### UI Framework

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| Astro page + controller | ✅ Use | New page `pillars.astro` with `pillars-controller.ts` |
| North Star card design | ✅ New component | `PillarCard.astro` — large masonry cards, NOT `CardCustomizer.astro` (that's a kanban toggle) |
| Masonry/grid layout | ✅ CSS Grid | CSS `grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))` — no JS layout library |

### HA Integration

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| HA sensors for Pillar attention | ✅ V2 | Not V1 scope but design schema to support |
| Principle conflict HA notification | ✅ V2 | Requires event-driven bridge |

## Confidence: HIGH
All stack decisions build on existing patterns. AI integration has a clear template (`fetchHabitContext` → `fetchPillarContext`). Strategic evaluator has extensible architecture.

## Sources
- `apps/web/src/domains/ai/ai-context-service.ts` (431 lines — prompt injection pattern)
- `packages/domain-strategy/src/rule-resolver.ts` (framework scoring pipeline)
- `apps/web/src/lib/controllers/today-focus-stack.ts` (100 lines — presentation layer)
- `apps/web/src/domains/habits/habit-service.ts` (service pattern reference)
