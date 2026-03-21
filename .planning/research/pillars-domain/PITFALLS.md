# Pillars Domain — Pitfalls Research (Expanded Scope)

**Date:** 2026-03-21 (v2 — expanded with Principles, AI, Strategy)
**Researcher:** Antigravity (codebase analysis + persona audit)

## Critical Pitfalls

### P1: Shame-Inducing Metrics (Risk: 5/5)
**What:** Showing "you haven't served your Health Pillar in 5 days" creates guilt for ADHD users.
**How it happens:** Treating Pillars like streaks or OKR progress.
**Prevention:**
- Pillars NEVER have failure states, red badges, or warning indicators
- Language is always positive — "opportunities" not "neglected"
- Alignment audit shows ALLOCATION ("35% this week") not PERFORMANCE ("failed")
- "Unaligned" task flag is neutral, not negative — gamification signal, never shame
**Tests:** UI audit for negative language. E2E: no `.pillar-warning`, no `.pillar-fail` classes.

### P2: AI Overstep — Blocking Users with Principles (Risk: 5/5)
**What:** AI becomes too aggressive enforcing Non-Negotiables, frustrating users.
**How it happens:** Hard-blocking schedule changes or auto-rejecting tasks that touch Principles.
**Prevention:**
- Conflict resolution is ALWAYS warning, NEVER hard-block
- AI **suggests** alternatives, never refuses actions
- "Boundary Conflict" UI is dismissible and logged (not modal-blocking)
- `isNonNegotiable` only affects AI tone, never user permissions
**Tests:** Verify conflict warning can always be dismissed. No HTTP 403 on Principle violations.

### P3: Blank Page Paralysis (Risk: 4/5)
**What:** "What are your core values?" is paralyzing for ADHD users staring at empty state.
**How it happens:** Onboarding dumps users into an empty masonry grid with a "+" button.
**Prevention:**
- AI onboarding wizard asks behavioral questions ("What boundary did someone cross last week?")
- AI drafts Pillars and Principles from answers — user edits, not creates from scratch
- Starter templates: "Health", "Wealth", "Relationships" with example Principles
- Empty state shows coaching prompt, not blank cards
**Tests:** Empty state UX renders coaching content, not blank grid.

### P4: Pillar Count Overload (Risk: 4/5)
**What:** Users create 20 Pillars, defeating cognitive load guardrail.
**How it happens:** No limit on creation. ADHD hyperfocus on setup.
**Prevention:**
- Soft limit of 7 with warning at 6th Pillar: "Research shows 3-5 Pillars is optimal"
- Never hard-block — allow creation but surface the warning
- Onboarding suggests 3-5 starting Pillars
**Tests:** Create 7+ Pillars, verify warning appears at #6.

### P5: Schema Migration Risk — ALTER TABLE on Existing Tables (Risk: 4/5)
**What:** Adding `pillar_id` FK to `goals`, `tasks`, `task_templates` can fail on large DBs.
**How it happens:** SQLite ALTER TABLE has limitations. Adding FK columns is safe, but FK enforcement depends on PRAGMA.
**Prevention:**
- Use `ALTER TABLE ... ADD COLUMN pillar_id TEXT` (no FK constraint in SQLite ALTER)
- FK relationship enforced in application code, not DB-level FK PRAGMA
- Migration in `ensureSchema()` — idempotent with try/catch for "column already exists"
- New `pillars` and `principles` tables use CREATE IF NOT EXISTS (safe)
**Tests:** Start fresh DB, verify columns added. Start DB with existing data, verify no errors.

## Moderate Pitfalls

### P6: Inheritance Complexity (Risk: 3/5)
**What:** Task → Project → Goal → Pillar inheritance chain breaks when intermediate entities lack Pillars.
**How it happens:** User creates Goal without Pillar, then expects Task under it to inherit.
**Prevention:**
- Inheritance is `Task.pillar_id ?? Goal.pillar_id ?? null`
- Missing intermediate Pillar = task is "unaligned" (neutral, not broken)
- No recursive chain — check direct FK, then parent Goal FK, done
**Tests:** Task under Goal with Pillar inherits. Task under Goal without Pillar shows "unaligned."

### P7: AI Context Window Overflow (Risk: 3/5)
**What:** Injecting all Principles into every AI prompt exceeds context limits.
**How it happens:** User has 7 Pillars × 5 Principles each = 35 statements in system prompt.
**Prevention:**
- Only inject Non-Negotiable Principles (typically 5-10 total, not all Principles)
- Format concisely: numbered list, one line per Principle
- Cap at 15 Principles in prompt, sorted by Pillar weight
**Tests:** Verify prompt construction with 35 Principles — stays under 500 tokens.

### P8: Strategic Evaluator Runaway Boost (Risk: 3/5)
**What:** High-weight Pillar tasks always dominate focus stack, crowding out important but un-Pillared tasks.
**How it happens:** `pillar_weight * boost_factor` overwhelms base priority score.
**Prevention:**
- Boost is additive, not multiplicative — caps at reasonable bound
- Boost factor is configurable in settings (default: modest bump)
- Un-Pillared tasks retain full base priority — Pillar boost is bonus, not penalty for missing
**Tests:** Task with weight-10 Pillar doesn't crowd out urgent un-Pillared task with high base priority.

### P9: North Star UX Too Different from Rest of App (Risk: 3/5)
**What:** Masonry-grid manifesto page feels disconnected from Meitheal's task-centric UI.
**How it happens:** Pillar cards use completely different design language than rest of app.
**Prevention:**
- PillarCard uses same CSS variables (--surface, --border, --accent)
- Same font stack, same border-radius, same shadow tokens
- Grid layout uses CSS grid (same as existing dashboard responsiveness)
- Blueprint click-through transitions to familiar list-style detail
**Tests:** Visual consistency audit — PillarCard shares design tokens with existing components.

## Minor Pitfalls

### P10: Pillar Deletion Orphans (Risk: 2/5)
**What:** Deleting a Pillar leaves `pillar_id` FKs on goals/tasks pointing to nothing.
**Prevention:**
- Soft-delete Pillars (isActive = false) — FKs remain valid
- Hard-delete: SET NULL on referencing FKs, CASCADE on principles + pillar_associations
**Tests:** Delete Pillar, verify referring goals/tasks get `pillar_id = null`.

### P11: Weight Field Misuse (Risk: 2/5)
**What:** Users set all Pillars to weight 10, negating the differentiation.
**Prevention:**
- Onboarding explains weight as "relative importance" — not every Pillar is 10
- UI hint: "Higher weight = higher priority boost for aligned tasks"
**Tests:** Weight slider shows explanation text.

## Phase Warnings

| Phase Risk | Warning |
|-----------|---------|
| V1 scope creep | North Star UX + AI integration + strategic evaluator is already ambitious. Guard scope. |
| ALTER TABLE migration | Test on copy of production DB before release |
| Principle ↔ Strategic Lens confusion | UI must distinguish "Principle = personal boundary" from "Lens = prioritization framework" |
| `userId` field | Include in schema now but don't enforce multi-user logic until auth overhaul |

## Confidence: HIGH
Pitfalls well-mapped from habit-service development, AI integration patterns, and user specification.
