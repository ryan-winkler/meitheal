# ADR-017: Pillars Domain — Identity-Based Motivational Anchors

**Date:** 2026-03-21
**Status:** Accepted
**Deciders:** Ryan Winkler, 50-persona GSD panel

## Context

Meitheal's hierarchy (Area → Goal → Project → Task) answers WHAT to do and WHERE it fits. Strategic Lenses answer HOW to prioritize. Routines answer WHAT to repeat. But nothing answers **WHY** — the identity-level motivation behind all of it.

Users (especially those with ADHD) need a stable anchor that persists across shifting goals and changing routines. Without it, task management becomes a list of obligations without meaning.

## Decision

### 1. Naming: "Pillars"

A 50-persona panel voted on naming:
- **Pillars:** 42% primary preference, 70%+ acceptable
- "Values": 28% — too personal/religious for some
- "Principles": 18% — too corporate
- "Foundations": 12% — too abstract

"Pillar" evokes structural support — something a house stands on. It's memorable, non-judgmental, and distinct from all existing Meitheal terms.

### 2. Separate Bounded Context

94% of the panel confirmed Pillars are a distinct domain concept — not a subtype of Goals, Lenses, or Areas.

| Concept | Answers | Lifespan | Can complete? |
|---------|---------|----------|---------------|
| **Pillar** | WHO am I? | Permanent | No |
| **Goal** | WHAT to achieve? | Temporary | Yes |
| **Area** | WHERE does this belong? | Permanent | No |
| **Lens** | HOW to prioritize? | Permanent | No |
| **Routine** | WHAT to repeat? | Ongoing | Streak-based |

Implementation: In-app domain at `apps/web/src/domains/pillars/` with M2M join table for associations.

### 3. Shame-Free UX Constraint

Pillars must NEVER display:
- Failure states or red badges
- Streak counters or completion percentages
- "Unlinked" warnings that imply neglect
- Negative language ("you haven't linked any goals")

Pillars are always framed as **identity statements**: "I am someone who..."

## Consequences

- New in-app domain `domains/pillars/` with isolated schema
- M2M `pillar_associations` table linking Pillars to Goals and Routines
- Soft limit of 7 active Pillars (ADHD cognitive load guardrail)
- Surfaced on `/habits` page as a new UnifiedBar section, not a separate route
- V2 will add task-level linkage, filter chips, analytics, and HA sensors

## References

- `.planning/research/pillars-domain/SUMMARY.md`
- `.planning/persona-loops/phase-17/iteration-01/`
- `apps/web/src/domains/pillars/pillar-service.ts`
