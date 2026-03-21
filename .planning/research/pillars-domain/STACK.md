# Pillars Domain — Stack Research

**Date:** 2026-03-21
**Researcher:** Antigravity (persona audit + web research)

## Technology Decisions

### Storage Layer

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| SQLite (existing) | ✅ Use | Consistent with all other domain data. No new dependencies. |
| Separate Pillar DB | ❌ Reject | Unnecessary complexity. Pillar data is small and relational. |

**Schema additions:**
- `pillars` table — aggregate root
- `pillar_associations` — many-to-many join (pillar_id, entity_type, entity_id)
- Migration via existing `ensureSchema()` pattern

### Domain Package

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| New `domain-pillars` package | ❌ Reject | Overhead for V1 — only ~200 LoC of domain logic needed |
| Extend `domain-strategy` | ❌ Reject | Pillars ≠ strategy rules. Different bounded context semantics. |
| New in-app domain `domains/pillars/` | ✅ Use | Matches existing `domains/habits/` pattern. Can extract to package later (V2). |

### API Layer

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| `/api/pillars` REST routes | ✅ Use | Consistent with `/api/habits`, `/api/goals`, `/api/tasks` |
| GraphQL | ❌ Reject | No GraphQL in the project. Unnecessary. |

### UI Framework

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| Astro page + controller | ✅ Use | Matches existing pattern (`habits.astro` + `habits-controller.ts`) |
| React/Vue island | ❌ Reject | No framework islands in Meitheal. Astro-native only. |

### HA Integration

| Option | Recommendation | Rationale |
|--------|---------------|-----------|
| HA sensors for Pillar attention % | ✅ V2 | Not V1 scope, but design data model to support it |
| HA automations on Pillar imbalance | ✅ V2 | Requires attention calculation engine — defer |

## Confidence: HIGH
All stack decisions align with existing patterns. No new dependencies needed.

## Sources
- Existing Meitheal codebase (`habit-service.ts`, `domain-model.ts`, `store.ts`)
- ADR-016 recurrence vs habits separation precedent
- TickTick, Todoist, Habitica feature analysis
