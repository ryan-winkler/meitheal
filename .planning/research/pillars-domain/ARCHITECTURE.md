# Pillars Domain — Architecture Research

**Date:** 2026-03-21
**Researcher:** Antigravity (codebase analysis + DDD audit)

## Domain Model

### Pillar Aggregate Root

```typescript
interface Pillar {
  id: string            // UUID
  name: string          // "Health & Vitality"
  description: string | null  // "I am someone who honors my body and mind"
  icon: string          // "💪" or emoji
  color: string         // "#10b981" hex color
  position: number      // Display order
  isActive: boolean     // Soft delete
  createdAt: number     // Unix timestamp
  updatedAt: number     // Unix timestamp
}
```

### Pillar Associations (Many-to-Many)

```typescript
interface PillarAssociation {
  id: string
  pillarId: string
  entityType: "goal" | "routine" | "task"
  entityId: string
  createdAt: number
}
```

**Why M2M join table instead of FK on each entity:**
1. A task can serve multiple Pillars ("Morning run" → Health + Discipline)
2. Adding a FK to every entity table is invasive and couples Pillars to all domains
3. Join table is isolated — Pillars domain owns it entirely
4. Easy to extend to new entity types later

### Hierarchy Position

```
Pillars (WHY - motivational anchors)
  └─ Areas (WHERE - life domains — classification only)
  └─ Goals (WHAT - measurable outcomes)
       └─ Projects (HOW - organized containers)
            └─ Tasks (DO - actionable items)
            └─ Routines (REPEAT - behavioral patterns)
```

Pillars are NOT above Areas in a strict tree. They are a *cross-cutting* dimension:
- A Pillar can span multiple Areas ("Health" Pillar spans Fitness, Nutrition, Mental Health Areas)
- An Area can be served by multiple Pillars ("Home" Area served by "Safety" and "Comfort" Pillars)

## Component Architecture

### Files to Create

| File | Purpose |
|------|---------|
| `apps/web/src/domains/pillars/pillar-service.ts` | CRUD, association logic, streak-free |
| `apps/web/src/pages/api/pillars.ts` | REST API: GET (list), POST (create) |
| `apps/web/src/pages/api/pillars/[id].ts` | REST API: GET, PATCH, DELETE |
| `apps/web/src/pages/api/pillars/[id]/associations.ts` | Link/unlink entities |
| `apps/web/src/lib/pillars-registry.ts` | Section definitions for UnifiedBar |
| `apps/web/src/lib/controllers/pillars-controller.ts` | Client-side page controller |
| `apps/web/src/components/pillars/PillarCard.astro` | Card component for Pillar display |
| `apps/web/src/components/pillars/PillarSelector.astro` | Dropdown/chip selector for task detail |

### Integration Points (Existing Files to Modify)

| File | Change |
|------|--------|
| `apps/web/src/pages/habits.astro` | Add Pillars section under existing shell |
| `apps/web/src/lib/habits-registry.ts` | Add `habits-pillars` section |
| `apps/web/src/components/layout/Sidebar.astro` | Add Pillars count to Progress & Growth |
| New Task Modal | Optional Pillar selector |
| Task Detail Panel | Show associated Pillars |
| Goal Detail (future) | Show associated Pillars |

### Data Flow

```
User creates Pillar → POST /api/pillars → pillar-service.createPillar() → SQLite
User links Goal to Pillar → POST /api/pillars/:id/associations → pillar_associations INSERT
Task Detail loads → GET /api/tasks/:id → includes pillar_associations via JOIN
Pillar page loads → GET /api/pillars → returns with connected entity counts
```

## Bounded Context Placement

**Option A (RECOMMENDED): In-app domain `domains/pillars/`**
- Matches `domains/habits/` pattern
- Owns `pillar-service.ts` with schema + CRUD
- Cross-context reads via REST API (not direct imports)
- Can extract to `packages/domain-pillars/` when complexity warrants it

**Option B: Extend habits domain**
- ❌ Rejected: Pillars ≠ Habits. Different lifecycle, different relationships, different UX.

**Option C: New package `domain-pillars`**
- ❌ Rejected for V1: Package overhead (~10 files for infra) vs. ~3 files of actual domain logic.

## Confidence: HIGH
Architecture follows established patterns. No novel architectural decisions needed.

## Sources
- Existing `domains/habits/habit-service.ts` pattern
- `packages/domain-tasks/src/domain-model.ts` hierarchy model
- ADR-007 hierarchy model, ADR-016 recurrence separation
