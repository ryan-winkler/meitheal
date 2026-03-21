# Pillars Domain — Research Summary (Expanded Scope)

**Date:** 2026-03-21 (v2 — synthesized from expanded STACK, FEATURES, ARCHITECTURE, PITFALLS)
**Synthesizer:** Antigravity

## Executive Summary

Meitheal's Pillars domain introduces identity-based motivational anchors — the WHY layer — into the task management hierarchy. Unlike any competitor (TickTick, Todoist, Things 3, Habitica, OmniFocus), Meitheal will combine structured Pillars with behavioral Principles/Non-Negotiables and AI-enforced boundaries. This is a genuine market differentiator.

The expanded scope adds Principles (child entities of Pillars), AI prompt injection (Non-Negotiable Principles guard the LLM), strategic evaluator Pillar-weight boosting, a North Star masonry UI, conflict resolution warnings, top-down inheritance, and an AI onboarding wizard. All integration hooks exist in the current codebase (`ai-context-service.ts`, `rule-resolver.ts`, `today-focus-stack.ts`).

The primary risk is scope size — this is the most ambitious Phase 17 feature set to date. Schema changes include a new `pillars` table, a new `principles` table, and additive ALTER TABLE on goals/tasks/routines with `pillar_id` FK. All patterns follow existing service architecture with no new dependencies.

## Key Findings

### From STACK.md
- All tech decisions align with existing patterns — SQLite, `ensureSchema()`, raw SQL
- AI integration follows `fetchHabitContext()` pattern → add `fetchPillarContext()`
- Strategic evaluator has extensible pre-computation hook in `rule-resolver.ts`
- North Star UX uses CSS Grid masonry, no JS layout library needed
- No new dependencies required

### From FEATURES.md
- **12 table stakes** features for V1 (Pillar CRUD, Principle CRUD, North Star page, Blueprint view, inheritance, shame-free design)
- **5 should-have** features (AI prompt injection, conflict UI, strategic boost, alignment audit, AI onboarding)
- **7 anti-features** explicitly blocked (streak counters, failure states, hard-blocks, sub-pillars)
- No competitor offers Pillars + Principles + AI enforcement together

### From ARCHITECTURE.md
- **Dual association strategy**: Direct `pillar_id` FK on entities (90% case) + M2M `pillar_associations` (10% power-user)
- **Principle model**: 1:N child of Pillar with `statement`, `isNonNegotiable`, `position`
- **Inheritance**: `Task.pillar_id ?? Goal.pillar_id ?? null` (explicit overrides inherited)
- **Schema fields per user**: `manifesto` (not description), `weight` (1-10), `colorHex`, `userId`
- **AI data flow**: fetchPillarContext → inject Non-Negotiables into system prompt → AI pushes back on conflicts
- **Strategy data flow**: pillar_weight × boost_factor → priority boost → today-focus-stack sort

### From PITFALLS.md
- **P1 (5/5)**: Shame-inducing metrics — always allocation, never performance
- **P2 (5/5)**: AI overstep — warnings only, never hard-blocks
- **P3 (4/5)**: Blank page paralysis — AI drafts Pillars from behavioral questions
- **P5 (4/5)**: ALTER TABLE migration — idempotent, application-level FK enforcement
- **P7 (3/5)**: AI context overflow — cap at 15 Non-Negotiable Principles in prompt
- **P8 (3/5)**: Strategic evaluator runaway — additive boost, not multiplicative

## Implications for Roadmap

### Suggested Sub-Phase Structure

Phase 17 is too large for a single wave structure. Recommend 3 sub-phases:

**Sub-Phase 17A: Core Domain (Foundation)**
- Pillar + Principle service, schema, types
- REST API routes for Pillars + Principles
- ADR-017, glossary update, AGENTS.md update
- E2E tests for CRUD + associations
- **Pitfalls to avoid:** P5 (ALTER TABLE), P10 (deletion orphans)

**Sub-Phase 17B: North Star UX + Linking**
- North Star masonry page (`pillars.astro`)
- PillarCard, PillarDetail (Blueprint view), PrincipleList components
- PillarSelector in Goal/Routine create modals
- "Unaligned" visual flag on tasks
- Progress page link/section
- **Pitfalls to avoid:** P4 (count overload), P9 (UX consistency)

**Sub-Phase 17C: Intelligence Layer**
- AI prompt injection (`fetchPillarContext()` in `ai-context-service.ts`)
- Strategic evaluator Pillar-weight boosting (`rule-resolver.ts`)
- Conflict resolution warnings (Non-Negotiable violations)
- Alignment audit chart (`progress.astro`)
- AI onboarding wizard (behavioral questions → drafted Pillars)
- **Pitfalls to avoid:** P2 (AI overstep), P3 (blank page), P7 (context overflow), P8 (runaway boost)

### Research Flags

| Sub-Phase | Needs Deep Research? | Why |
|-----------|---------------------|-----|
| 17A | ❌ No | Standard service patterns — well-documented |
| 17B | ⚠️ Minor | Masonry layout UX decisions, card design |
| 17C | ✅ Yes | AI prompt engineering, boost algorithm tuning, conflict detection rules |

## Confidence Assessment

| Area | Confidence | Notes |
|------|-----------|-------|
| Stack | HIGH | All existing patterns, no new deps |
| Features | HIGH | User-specified with LOCKED decisions, persona-validated |
| Architecture | HIGH | Dual FK+M2M validated, integration hooks confirmed in codebase |
| Pitfalls | HIGH | Well-mapped from prior domain development |
| AI Integration | MEDIUM | Prompt engineering needs iteration; conflict detection rules TBD |
| Strategic Boost | MEDIUM | Algorithm tuning (additive vs multiplicative, cap) needs experimentation |

### Gaps to Address
- Boost factor algorithm — needs prototyping during 17C
- Conflict detection rules — when exactly does a scheduled task violate a Principle?
- AI onboarding wizard UX — conversation flow design needed
- `userId` field — schema-ready but no multi-user enforcement until auth overhaul

## Sources

### Research Files
- `.planning/research/pillars-domain/STACK.md` (v2)
- `.planning/research/pillars-domain/FEATURES.md` (v2)
- `.planning/research/pillars-domain/ARCHITECTURE.md` (v2)
- `.planning/research/pillars-domain/PITFALLS.md` (v2)

### Codebase Integration Points (Audited)
- `apps/web/src/domains/ai/ai-context-service.ts` (431 lines)
- `packages/domain-strategy/src/rule-resolver.ts` (framework scoring)
- `apps/web/src/lib/controllers/today-focus-stack.ts` (100 lines)
- `apps/web/src/components/tasks/StrategicEvaluator.astro` (521 lines)
- `apps/web/src/domains/habits/habit-service.ts` (service pattern)
- `apps/web/src/components/ui/CardCustomizer.astro` (field toggle, NOT card visual)

### Prior Research
- 50-persona naming audit (Phase 17 Iteration 01)
- ADR-016 recurrence vs habits separation precedent
- User schema specification (2026-03-21)
