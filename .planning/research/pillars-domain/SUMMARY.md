# Pillars Domain — Research Synthesis

**Date:** 2026-03-21
**Synthesized from:** STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md, 50-Persona Expert Audit

---

## Executive Summary

Meitheal's hierarchy (Area → Goal → Project → Task → Routine) answers WHAT, WHERE, and HOW, but not WHY. The 50-persona panel (42% primary vote, 94% domain-distinction consensus) confirmed that a new concept called **"Pillars"** — permanent, identity-based motivational anchors — fills this gap. No major task management app (TickTick, Todoist, Habitica, Things 3, OmniFocus) offers a structured values/pillars layer, making this a genuine market differentiator.

Pillars are architecturally distinct from Goals (temporary measurable outcomes), Strategic Lenses (prioritization rules), Areas (life domain classification), and Routines (repeating behavioral patterns). They represent *who you want to be*, not what you want to achieve. Implementation follows Meitheal's established patterns: in-app domain (`domains/pillars/`), SQLite schema, REST API, Astro page + controller.

The critical design constraint is **shame-free UX**: no failure states, no streak counters, no "you're neglecting this" notifications. Pillars are always positive anchors — opportunities, not obligations. This is non-negotiable for ADHD users (the primary persona).

## Key Findings

### Stack
- **SQLite** — existing store, no new dependencies
- **In-app domain** `domains/pillars/` — matches `domains/habits/` pattern, extract to package later
- **REST API** at `/api/pillars` — consistent with all other domain APIs
- **Astro page + controller** — established pattern

### Features
- **V1 table stakes:** CRUD, icon/color, max 7 limit, goal linkage, identity framing, shame-free design
- **V2:** Task linkage, filter chips, contextual badges, attention analytics
- **Anti-features:** No streak counters, no failure notifications, no mandatory assignment, no sub-pillars
- **Competitive gap:** Zero competitors have a structured pillars/values layer

### Architecture
- **Pillar aggregate root** — id, name, description, icon, color, position, isActive
- **Many-to-many associations** via `pillar_associations` join table (not FK on each entity)
- **12 files to create/modify** — mostly new files, minimal modification of existing code
- **Bounded context:** In-app domain, cross-context reads via REST API only

### Pitfalls
- **P1 CRITICAL:** Shame-inducing metrics — Pillars must NEVER show failure
- **P2 CRITICAL:** Pillar count overload — soft limit of 7, suggest 3-5
- **P3 CRITICAL:** Naming collision with existing Habits — strict ubiquitous language enforcement
- **P4-P8 MODERATE/MINOR:** M2M query complexity, UI surface area scope, migration safety, deletion orphans, position gaps

## Implications for Roadmap

### Suggested Phase Structure

**Phase 17: Pillars Domain Introduction**

| Sub-phase | Deliverables | Depends On |
|-----------|-------------|------------|
| 17.1 — Schema & Service | `pillars` table, `pillar_associations` table, `pillar-service.ts` CRUD | None |
| 17.2 — API & Basic UI | `/api/pillars` routes, Pillar list page under `/progress` | 17.1 |
| 17.3 — Goal Integration | Pillar selector in Goal create/edit, Pillar badge on Goal cards | 17.2 |
| 17.4 — Routine Integration | Pillar selector in Routine/Habit create/edit | 17.2 |

### Research Flags
- **17.1:** Standard patterns — no additional research needed
- **17.2:** Needs decision on Progress & Growth page structure (tabs vs. sections)
- **17.3-17.4:** Standard integration — follow existing Goal/Routine UI patterns

## Confidence Assessment

| Area | Confidence | Notes |
|------|-----------|-------|
| Stack | HIGH | All decisions use existing patterns |
| Features | HIGH | 50-persona validation + competitive gap |
| Architecture | HIGH | Follows established DDD patterns |
| Pitfalls | HIGH | Well-understood from habit-service development |
| **Overall** | **HIGH** | Strong research foundation, clear implementation path |

## Gaps to Address During Planning
1. Progress & Growth page tab structure (currently has Routines/Goals/Achievements — where do Pillars appear?)
2. Sidebar navigation update (Pillar count badge?)
3. HA entity naming reservation (namespace planning for future sensors)

## Sources
- 50-Persona Expert Audit (ADHD, Fair Play, UX, behavioral psychology, product architecture)
- TickTick, Todoist, Habitica, Things 3, OmniFocus competitive analysis
- Existing Meitheal codebase: `habit-service.ts`, `domain-model.ts`, `rule-types.ts`
- ADR-007 (hierarchy model), ADR-016 (recurrence vs habits separation)
- Fair Play by Eve Rodsky, Atomic Habits by James Clear, PARA by Tiago Forte
