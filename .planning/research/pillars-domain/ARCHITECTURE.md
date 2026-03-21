# Pillars Domain — Architecture Research (Expanded Scope)

**Date:** 2026-03-21 (v2 — expanded with Principles, AI, Strategy, user schema)
**Researcher:** Antigravity (codebase analysis + user schema direction)

## Domain Model

### Pillar Aggregate Root

```typescript
interface Pillar {
  id: string              // UUID
  userId: string          // Future multi-user readiness
  name: string            // "Physical Longevity"
  manifesto: string | null  // The WHY — "I am someone who honors my body"
  icon: string            // "💪" emoji
  colorHex: string        // "#10b981"
  weight: number          // 1-10, algorithmic sorting & priority boosting
  position: number        // Display order
  isActive: boolean       // Soft delete
  createdAt: number       // Unix timestamp
  updatedAt: number       // Unix timestamp
}
```

### Principle (Child of Pillar, 1:N)

```typescript
interface Principle {
  id: string
  pillarId: string        // FK → pillars.id ON DELETE CASCADE
  statement: string       // "No screens after 9 PM"
  isNonNegotiable: boolean  // Graduated enforcement — true = AI will push back
  position: number        // Display order within Pillar
  createdAt: number
}
```

### Schema (raw SQL via ensureSchema pattern)

```sql
CREATE TABLE IF NOT EXISTS pillars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  manifesto TEXT,
  icon TEXT NOT NULL DEFAULT '🏛️',
  color_hex TEXT NOT NULL DEFAULT '#6366f1',
  weight INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS principles (
  id TEXT PRIMARY KEY,
  pillar_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  is_non_negotiable INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pillar_id) REFERENCES pillars(id) ON DELETE CASCADE
);

-- Direct FK on existing entities (ALTER TABLE — additive, safe)
-- goals: ADD COLUMN pillar_id TEXT REFERENCES pillars(id)
-- tasks: ADD COLUMN pillar_id TEXT REFERENCES pillars(id)
-- task_templates (routines): ADD COLUMN pillar_id TEXT REFERENCES pillars(id)
```

### Dual Association Strategy

**Primary:** Direct `pillar_id` FK on goals, tasks, routines → simple, one Pillar per entity
**Secondary:** `pillar_associations` M2M table → cross-cutting cases (task serves 2+ Pillars)

The `pillar_associations` table is RETAINED because:
1. A task like "Morning run" can serve both "Health" and "Discipline" Pillars
2. The M2M table is isolated — Pillars domain owns it, no other schema impact
3. Direct FK handles 90% of cases (inheritance). M2M handles the 10% power-user case.

### Hierarchy Position

```
Pillars (WHO — identity anchors, cross-cutting)
  └─ Principles (BOUNDARIES — behavioral rules per Pillar)

Area (WHERE — life domains)
  └─ Goal (WHAT — measurable outcome, pillar_id FK)
       └─ Project (HOW — organized container)
            └─ Task (DO — atomic work, inherits pillar_id from Goal)
            └─ Routine (REPEAT — behavioral pattern, pillar_id FK)
```

### Inheritance Model

```
Task.pillarId  →  Task.explicit_pillar_id  ??  parent Project.Goal.pillar_id  ??  null (unaligned)
```

- Explicit assignment overrides inherited
- "Unaligned" visual flag (gamification signal, not shame)

## Component Architecture

### Files to Create/Modify

| File | Purpose |
|------|---------|
| **NEW** `domains/pillars/pillar-service.ts` | Schema, CRUD (Pillars + Principles), associations, inheritance |
| **NEW** `pages/api/pillars.ts` | GET (list), POST (create) |
| **NEW** `pages/api/pillars/[id].ts` | GET, PATCH, DELETE |
| **NEW** `pages/api/pillars/[id]/principles.ts` | Principle CRUD |
| **NEW** `pages/api/pillars/[id]/associations.ts` | Link/unlink entities |
| **NEW** `pages/pillars.astro` | North Star page — masonry grid |
| **NEW** `lib/controllers/pillars-controller.ts` | Client-side page logic |
| **NEW** `components/pillars/PillarCard.astro` | Large manifesto card |
| **NEW** `components/pillars/PillarDetail.astro` | Blueprint view (WHY + Principles + linked entities) |
| **NEW** `components/pillars/PrincipleList.astro` | Principle items with non-negotiable badge |
| **NEW** `components/pillars/PillarSelector.astro` | Dropdown for Goal/Routine/Task modals |
| **MODIFY** `domains/ai/ai-context-service.ts` | Add `fetchPillarContext()` — inject Principles into prompt |
| **MODIFY** `packages/domain-strategy/src/rule-resolver.ts` | Pillar-weight pre-computation |
| **MODIFY** `pages/progress.astro` | Add Pillars section or link to North Star page |
| **MODIFY** Goal/Routine create modals | Add PillarSelector |

### AI Integration Data Flow

```
User schedules task
  → fetchPillarContext() gets active Non-Negotiable Principles
  → Principles injected into system prompt:
    "The user operates by these Non-Negotiables:
     1. Protect 7 AM workouts
     2. Family dinner at 6 PM
     YOU MUST NEVER suggest rearrangements that violate these."
  → AI pushes back if conflict detected
```

### Strategic Evaluator Data Flow

```
Task.pillarId → lookup Pillar.weight (1-10)
  → priority_boost = base_score + (pillar_weight * boost_factor)
  → If Task upholds Non-Negotiable Principle → additional hard boost
  → Boosted score flows into Eisenhower/ICE/RICE engines
  → today-focus-stack ordering affected (server-side sort)
```

### Conflict Resolution Flow

```
User schedules task at 6 PM Thursday
  → Check: any Non-Negotiable Principles violated?
  → "Family Weekends" principle covers Thursday evening
  → Show warning: "Boundary Conflict: This violates 'Family Weekends'. Proceed?"
  → User can dismiss (logged) or reschedule
  → Never hard-block
```

## Bounded Context Placement

**Decision: In-app domain `domains/pillars/`**
- Owns `pillar-service.ts` with schema, CRUD, Principle CRUD, associations
- Cross-context reads via REST API
- AI integration via `fetchPillarContext()` in existing ai-context-service
- Strategy integration via `pillarWeightBoost()` export consumed by rule-resolver

## Confidence: HIGH
Architecture follows established patterns with well-understood integration hooks.

## Sources
- `domains/habits/habit-service.ts` (service pattern)
- `domains/ai/ai-context-service.ts` (AI prompt injection pattern)
- `packages/domain-strategy/src/rule-resolver.ts` (framework scoring)
- `components/ui/CardCustomizer.astro` (field toggle — NOT the card visual)
- User schema specification (Drizzle-style, 2026-03-21)
