# Phase 19: Pillars UX Polish — Research

**Researched:** 2026-03-21
**Domain:** Pillars domain, URL routing, search architecture
**Confidence:** HIGH

## Summary

Phase 19 addresses three UX gaps: principles hidden behind detail pages, ugly auto-generated pillar URLs, and a duplicated search bar. All three are surgical changes within the existing pillars domain and layout architecture.

The codebase already has all the infrastructure needed — no new dependencies required. Principle data is already fetched on the Pillars page (for the count badge), slug generation is a straightforward string utility, and the Layout already conditionally renders components based on page context.

**Primary recommendation:** Add principles to PillarCard props, add slug column with migration + backfill, conditionally suppress TopNavigation search when UnifiedBar is present.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Principles MUST be visible on Pillars page itself — not hidden away
- Each PillarCard should show its principles inline
- Non-Negotiable principles should be visually distinct
- Pillar detail URLs must use title slugs: `/pillars/physical-longevity`
- Add `slug` column with migration
- Keep `id` as internal PK, `slug` for URL routing
- Rename route `[id].astro` → `[slug].astro`
- Existing pillars need slug backfill
- Old search bar only renders when no unified bar is present

### Claude's Discretion
- Principle display layout (inline list, accordion, chips)
- Slug collision handling (counter suffix vs error)
- Whether to truncate principles with "show more"

### Deferred Ideas (OUT OF SCOPE)
- Full search unification across ALL pages
- Principle CRUD from within PillarCard
- Pillar reordering drag-and-drop
</user_constraints>

## Standard Stack

### Core (already in codebase)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Astro SSR | 6.0.4 | Page routing, SSR | Already in use |
| SQLite/Drizzle | N/A | DB persistence | Already in use |
| pageLifecycle | Internal | Client-side lifecycle | Already in use |

### No New Dependencies
This phase requires no new packages. All changes are within existing domain boundaries.

## Architecture Patterns

### Pillar Domain Structure
```
apps/web/src/domains/pillars/
├── pillar-service.ts          # CRUD, schema, generateId()
├── principle-service.ts       # Principle CRUD, types
├── pillar-association-service.ts  # Entity associations
```

### Current Pillar Schema
```sql
CREATE TABLE pillars (
  id TEXT PRIMARY KEY,          -- pillar_1774108575198_z5rmii
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
)
```

**Missing:** `slug TEXT UNIQUE` column

### Current ID Generation
```typescript
function generateId(): string {
  return `pillar_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}
```

### Current Principle Type
```typescript
interface Principle {
  id: string
  pillarId: string
  statement: string       // "No screens after 9 PM"
  isNonNegotiable: boolean  // true = injected into AI prompts
  position: number
  createdAt: number
}
```

### Current PillarCard Props
```typescript
interface Props {
  id: string
  name: string
  manifesto: string | null
  icon: string | null
  colorHex: string | null
  weight: number
  principleCount: number       // numeric badge only
  linkedGoalCount: number
}
```

**Gap:** No `principles: Principle[]` prop — only a count number.

### Search Architecture
| Layer | Component | Purpose |
|-------|-----------|---------|
| Old | `TopNavigation.astro` → `global-search` input | Deprecated search bar |
| New | `UnifiedBar.astro` → `SearchHub.astro` | Unified search/filter/action bar |
| Both | `Layout.astro` | Renders BOTH TopNavigation AND SearchHub |

**Pages with UnifiedBar:** tasks, today, upcoming, eisenhower, habits, settings, index
**Pages via ParentPageShell:** planning, progress (ParentPageShell includes UnifiedBar)
**Pages without UnifiedBar:** calendar, kanban, table, timeline, gamification, review

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slug generation | Custom regex | Simple kebab-case function | Standard pattern, handles edge cases |
| DB migration | Manual ALTER TABLE | Same pattern as `ensurePillarSchema()` | Already established migration pattern |
| Conditional rendering | Page-level flags | Astro component slots/props | Cleaner, DDD-aligned |

## Common Pitfalls

### Pitfall 1: Slug Uniqueness on Rename
**What goes wrong:** User renames pillar, slug becomes stale or collides
**Why it happens:** Slug generated only on creation
**How to avoid:** Regenerate slug on pillar update, append counter on collision
**Warning signs:** 404s on pillar detail pages after rename

### Pitfall 2: Breaking Existing Pillar Links
**What goes wrong:** Old `/pillars/pillar_1774108575198_z5rmii` links break
**Why it happens:** Route changed from `[id]` to `[slug]`
**How to avoid:** Add redirect middleware or keep `[id]` route as fallback
**Warning signs:** 404s from bookmarks, HA ingress references

### Pitfall 3: Principle Data N+1 Queries
**What goes wrong:** Fetching principles per pillar in a loop = N+1 queries
**Why it happens:** `getPrinciplesForPillar()` called per PillarCard
**How to avoid:** Batch fetch all principles and group by pillarId
**Warning signs:** Slow page load with many pillars

### Pitfall 4: TopNavigation Search Bar Re-appearing
**What goes wrong:** Old search bar appears when it shouldn't
**Why it happens:** Layout-level rendering doesn't know page context
**How to avoid:** Use a Layout prop like `hideGlobalSearch` or check for UnifiedBar slot
**Warning signs:** Visual duplication shown in user screenshot

## Code Examples

### Slug Generation (recommended pattern)
```typescript
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')  // Remove non-word chars
    .replace(/\s+/g, '-')      // Spaces to hyphens
    .replace(/-+/g, '-')       // Collapse multiple hyphens
    .replace(/^-|-$/g, '')     // Trim leading/trailing hyphens
}
```

### Schema Migration (existing pattern)
```typescript
// In ensurePillarSchema():
try {
  await client.execute("ALTER TABLE pillars ADD COLUMN slug TEXT UNIQUE")
  // Backfill existing pillars
  const rows = await client.execute("SELECT id, name FROM pillars WHERE slug IS NULL")
  for (const row of rows.rows) {
    const slug = generateSlug(String(row.name))
    await client.execute({ sql: "UPDATE pillars SET slug = ? WHERE id = ?", args: [slug, String(row.id)] })
  }
} catch { /* column already exists */ }
```

### Conditional Search Bar
```astro
<!-- Layout.astro -->
{!hideGlobalSearch && <TopNavigation ... />}
```

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `apps/web/src/domains/pillars/` — all service files read
- Codebase analysis: `apps/web/src/components/pillars/` — PillarCard props read
- Codebase analysis: `apps/web/src/layouts/Layout.astro` — dual search rendering confirmed
- Codebase analysis: `apps/web/src/components/layout/TopNavigation.astro` — old search confirmed

## Metadata

**Confidence breakdown:**
- Principles display: HIGH — data already fetched, just needs prop threading
- Slug URLs: HIGH — standard pattern, clear migration path
- Search bar: HIGH — conditional rendering, well-understood architecture

**Research date:** 2026-03-21
**Valid until:** 2026-04-21 (stable codebase, no external dependency changes)
