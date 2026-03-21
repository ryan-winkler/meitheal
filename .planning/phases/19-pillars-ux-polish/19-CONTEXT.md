# Phase 19: Pillars UX Polish — Context

**Gathered:** 2026-03-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Three surgical UX improvements to the Pillars domain and search architecture:

1. **Principles visible on Pillars page** — principles (behavioral boundaries) must be visually represented on each PillarCard, not hidden behind a detail page click
2. **Human-readable pillar URLs** — `/pillars/physical-longevity` not `/pillars/pillar_1774108575198_z5rmii`
3. **Kill deprecated search bar** — remove old `TopNavigation` search bar from pages that have the unified bar

</domain>

<decisions>
## Implementation Decisions

### Principles Display
- Principles MUST be visible on the Pillars page itself
- Each PillarCard should show its principles inline (expanded or summary)
- Non-Negotiable principles should be visually distinct (they're injected into AI prompts)
- Don't require clicking into detail page to see principles

### URL Slugs
- Pillar detail URLs must use title slugs: `/pillars/physical-longevity`
- Add `slug` column to pillars table with migration
- Generate slugs from pillar name on creation (kebab-case, sanitized)
- Keep `id` as internal primary key, use `slug` for URL routing
- Route file: rename `[id].astro` → `[slug].astro`
- Existing pillars need slug backfill on schema migration

### Deprecated Search Bar
- `TopNavigation.astro` has `global-search` input — this is the OLD search bar
- Pages with `UnifiedBar` (or `ParentPageShell` which includes it) must NOT show old bar
- The old bar should only render when no unified bar is present on the page
- Long-term: remove old search entirely when all pages have unified bar

### Claude's Discretion
- Principle display layout (inline list, expandable accordion, chip badges, etc.)
- Slug collision handling strategy (append counter vs error)
- Whether to show all principles or truncate with "show more"

</decisions>

<specifics>
## Specific Ideas

- PillarCard currently shows `principleCount` as a numeric badge — replace or augment with actual principle text
- Non-Negotiable principles are special (injected into AI) — visually differentiate them (bold, icon, color)
- The user screenshot shows the old "Search Meitheal" bar AND the unified "Search progress & growth" bar — clear duplication
- Treat URLs like APIs — human-readable and presentable

</specifics>

<deferred>
## Deferred Ideas

- Full search unification across ALL pages (some pages like calendar/kanban still need migration)
- Principle CRUD from within PillarCard (editing principles inline vs detail page)
- Pillar reordering drag-and-drop on the masonry grid

</deferred>

---

*Phase: 19-pillars-ux-polish*
*Context gathered: 2026-03-21*
