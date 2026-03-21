# ADR-017: Pillars Domain — Identity-Based Motivational Anchors

**Date:** 2026-03-21 (updated with expanded scope)
**Status:** Accepted
**Deciders:** Ryan Winkler, 50-persona GSD panel (iterations 01 + 02)

## Context

Meitheal's hierarchy (Area → Goal → Project → Task) answers WHAT to do and WHERE it fits. Strategic Lenses answer HOW to prioritize. Routines answer WHAT to repeat. But nothing answers **WHY** — the identity-level motivation behind all of it.

Users (especially those with ADHD) need a stable anchor that persists across shifting goals and changing routines. Without it, task management becomes a list of obligations without meaning.

## Decisions

### 1. Naming: "Pillars"

A 50-persona panel voted on naming:
- **Pillars:** 42% primary preference, 70%+ acceptable
- "Values": 28% — too personal/religious for some
- "Principles": 18% — too corporate (but retained as sub-entity name)
- "Foundations": 12% — too abstract

"Pillar" evokes structural support — something a house stands on.

### 2. Principles / Non-Negotiables (Sub-Layer)

Principles are behavioral boundaries within a Pillar. Each Pillar has 0:N Principles.

| Term | Definition | Example |
|------|-----------|---------|
| **Pillar** | The WHY — permanent identity anchor | "Physical Longevity" |
| **Principle** | The BOUNDARY — behavioral rule | "No screens after 9 PM" |
| **Non-Negotiable** | A Principle with `isNonNegotiable = true` — injected into AI prompts | "Never skip a Monday workout" |

### 3. Separate Bounded Context

94% of the panel confirmed Pillars are a distinct domain concept.

| Concept | Answers | Lifespan | Can complete? |
|---------|---------|----------|---------------|
| **Pillar** | WHO am I? | Permanent | No |
| **Principle** | What won't I compromise? | Permanent | No |
| **Goal** | WHAT to achieve? | Temporary | Yes |
| **Area** | WHERE does this belong? | Permanent | No |
| **Lens** | HOW to prioritize? | Permanent | No |
| **Routine** | WHAT to repeat? | Ongoing | Streak-based |

Implementation: In-app domain at `apps/web/src/domains/pillars/` with 3 services:
- `pillar-service.ts` — Pillar CRUD
- `principle-service.ts` — Principle CRUD, `getNonNegotiablePrinciples()`
- `pillar-association-service.ts` — M2M join + direct FK + inheritance

### 4. Dual Association Strategy

- **Primary:** Direct `pillar_id` FK on `goals`, `tasks`, `task_templates` (one Pillar per entity)
- **Secondary:** `pillar_associations` M2M table (cross-cutting, multiple Pillars per entity)
- **Inheritance:** `Task.pillar_id ?? Goal.pillar_id ?? null` ("unaligned")

### 5. AI Integration

- Non-Negotiable Principles injected into LLM system prompts via `fetchPillarContext()`
- Follows existing `fetchHabitContext()` pattern in `ai-context-service.ts`
- Capped at 15 Principles, sorted by Pillar weight
- AI pushes back on conflicts — **always warning, never hard-block**

### 6. Strategic Evaluator

- Pillar `.weight` (1-10) provides additive boost to task priority scores
- Pre-computation step in `rule-resolver.ts` before framework scoring
- Transparent "Pillar boost: +N" indicator on task views

### 7. Shame-Free UX Constraint

Pillars must NEVER display failure states, streak counters, or negative language.
Pillars are always framed as **identity statements**: "I am someone who..."
"Unaligned" tasks show neutral gamification signal, not shame.

### 8. North Star UX

The Pillars page uses a masonry-grid layout with large manifesto-first cards.
It must NOT look like a task list or Kanban board.
Manifesto text is the hero element; Pillar name is secondary.

## Consequences

- New in-app domain `domains/pillars/` with 3 service files
- 3 schema tables: `pillars`, `principles`, `pillar_associations`
- ALTER TABLE on `goals`, `tasks`, `task_templates` for direct `pillar_id` FK
- Soft limit of 7 active Pillars (ADHD cognitive load guardrail)
- North Star masonry page at `/pillars`
- AI integration via `fetchPillarContext()` with Non-Negotiable enforcement
- Strategic evaluator Pillar-weight boost in `rule-resolver.ts`
- Conflict resolution via toast warnings (never modals, never hard-blocks)

## References

- `.planning/research/pillars-domain/SUMMARY.md`
- `.planning/phases/17-pillars-domain/17-CONTEXT.md`
- `.planning/persona-loops/phase-17/iteration-02/`
