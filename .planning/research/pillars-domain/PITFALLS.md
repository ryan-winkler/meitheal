# Pillars Domain — Pitfalls Research

**Date:** 2026-03-21
**Researcher:** Antigravity (50-persona audit + prior ADR analysis)

## Critical Pitfalls

### P1: Shame-Inducing Metrics (Risk: 5/5)
**What:** Showing "you haven't served your Health Pillar in 5 days" creates guilt, especially for ADHD users.
**How it happens:** Treating Pillars like streaks (habits model) or like OKR progress (goals model).
**Prevention:**
- Pillars NEVER have failure states, red badges, or warning indicators
- Language is always positive: "opportunities" not "neglected"
- No Pillar streak counter — that's what Routines are for
- Pillar attention metrics (V2) should show ALLOCATION ("35% this week") not PERFORMANCE ("failed")
**Tests:** UI review for negative language/red indicators. E2E: no `.pillar-warning`, no `.pillar-fail` classes.

### P2: Pillar Count Overload (Risk: 4/5)
**What:** Users create 20 Pillars, defeating the purpose (cognitive overload paralysis).
**How it happens:** No guardrail on creation. ADHD hyperfocus on setup vs. execution.
**Prevention:**
- Soft limit of 7 with "Are you sure?" prompt above 5
- Onboarding suggests 3-5 starting Pillars
- Show a "research shows 3-5 Pillars is optimal" hint during creation
**Tests:** UI shows warning banner when 6th Pillar created.

### P3: Naming Collision with Existing Habits (Risk: 4/5)
**What:** Users confuse Pillars with Habits/Routines because "Habit" was the working name.
**How it happens:** Feature is introduced as "Habits" and never renamed. Or UI doesn't clearly distinguish.
**Prevention:**
- Ubiquitous language: ALWAYS "Pillar" in code, UI, docs, and conversations
- Clear distinction in UI: Routines have streaks/completions. Pillars have connections/associations.
- Onboarding tooltip: "Pillars are who you want to be. Routines are what you do every day."
**Tests:** Grep codebase for any use of "habit" when meaning "pillar." No file named `*habit*` should contain Pillar logic.

## Moderate Pitfalls

### P4: Many-to-Many Complexity (Risk: 3/5)
**What:** `pillar_associations` join table adds query complexity when loading tasks with their Pillars.
**How it happens:** N+1 queries when rendering task lists. Need to JOIN or batch-fetch associations.
**Prevention:**
- Fetch Pillar associations in batch: `SELECT * FROM pillar_associations WHERE entity_type = 'task' AND entity_id IN (?)`
- Cache Pillar list (small, rarely changes) on the client side
- Task list endpoints include Pillar info via LEFT JOIN, not separate request
**Tests:** Performance test: loading 100 tasks with Pillars in < 100ms.

### P5: UI Integration Surface Area (Risk: 3/5)
**What:** Pillars need to appear in many places (task detail, goal detail, settings, sidebar, search).
**How it happens:** Trying to integrate everywhere at once in V1.
**Prevention:**
- V1: Only Pillar CRUD page + optional Pillar selector in Goal create/edit
- V2: Task detail badge, filter chips, sidebar counts
- V3: Analytics, HA sensors, calendar tinting
**Tests:** Each integration point has its own user story and Tier 1 verification.

### P6: Migration Backward Compatibility (Risk: 3/5)
**What:** New `pillars` and `pillar_associations` tables need to be safe to add.
**How it happens:** Schema migration fails on existing SQLite databases.
**Prevention:**
- Use `CREATE TABLE IF NOT EXISTS` (same as habit-service.ts pattern)
- Pillar data is additive — no existing tables modified
- No `ALTER TABLE` needed on existing tables (using join table, not FK)
**Tests:** Start fresh DB, verify tables created. Start existing DB with data, verify no errors.

## Minor Pitfalls

### P7: Pillar Deletion Orphans (Risk: 2/5)
**What:** Deleting a Pillar leaves orphaned associations.
**How it happens:** Missing CASCADE or cleanup logic.
**Prevention:**
- Soft-delete Pillars (`isActive = false`) — associations remain but don't render
- If hard-delete: `DELETE FROM pillar_associations WHERE pillar_id = ?` first
- FK with `ON DELETE CASCADE` on `pillar_associations.pillar_id`
**Tests:** Delete Pillar, verify no orphaned associations in DB.

### P8: Position Column Gaps (Risk: 1/5)
**What:** Drag-reorder leaves position gaps (1, 3, 7) that accumulate over time.
**How it happens:** Standard re-ordering approach doesn't normalize positions.
**Prevention:**
- Same approach as existing task reorder — position is a float, not int
- Or: normalize positions on each reorder (simple for max 7 items)
**Tests:** Reorder 5 Pillars, verify positions are sequential.

## Phase Warnings

| Phase Risk | Warning |
|-----------|---------|
| V1 scope creep | Keep V1 to CRUD + goal linkage. Resist adding analytics/filtering. |
| Pillar ↔ Routine naming | UI must CLEARLY distinguish "Pillar" (identity anchor) from "Routine" (daily behavior). |
| Gender sensitivity | Pillar descriptions should avoid prescriptive language. "I honor..." not "I must..." |
| HA entity naming | Reserve `sensor.meitheal_pillar_*` namespace now, even if not implementing in V1 |

## Confidence: HIGH
Pitfalls are well-understood from habit-service development and persona audit feedback.
