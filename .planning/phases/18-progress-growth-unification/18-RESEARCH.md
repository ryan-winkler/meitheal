# Phase 18: Progress & Growth Unification — Research

**Researched:** 2026-03-21
**Domain:** Astro SSR hash routing, History API, component extraction
**Confidence:** HIGH

## Summary

The Progress & Growth page uses `ParentPageShell` + `UnifiedBar` — the same shell as Tasks and Planning. The architecture is sound but has implementation gaps:

1. **Back button broken**: `parent-page-controller.ts:80` uses `history.replaceState` instead of `pushState`, preventing back/forward navigation
2. **Hub-card indirection**: Each sub-view shows a summary card with "Open X →" linking to a separate page — defeating the purpose of the shell
3. **Duplicate search bar**: The global `SearchHub` in `Layout.astro` header AND the `UnifiedBar` search launcher both appear
4. **Click conflicts**: The `parent-page-controller` and standalone page controllers can both attach handlers to the same elements

**Primary recommendation:** Fix `pushState`, replace hub cards with inline content, remove global search from Layout when UnifiedBar is present, and ensure controller isolation.

## Standard Stack

### Core (already in use)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Astro | 5.x | SSR framework | Project foundation |
| History API | Web Standard | Hash routing | No dependencies needed |
| `pageLifecycle` | Internal | Event lifecycle | Already used everywhere |
| `parent-page-controller` | Internal | Hash section switching | Phase 15 architecture |

### No New Dependencies Needed
This phase is purely restructuring existing code. No new packages required.

## Architecture Patterns

### Pattern 1: pushState for Hash Navigation
**What:** Replace `replaceState` with `pushState` for hash changes to enable back/forward
**When to use:** Any time a user-initiated action changes the visible section

```typescript
// BEFORE (broken back button)
history.replaceState(null, "", `#${sectionId}`)

// AFTER (supports back/forward)
if (window.location.hash !== `#${sectionId}`) {
  history.pushState({ section: sectionId }, "", `#${sectionId}`)
}
```

### Pattern 2: Inline Sub-Page Content
**What:** Render sub-page content directly inside `data-parent-section` containers instead of behind summary cards
**When to use:** Progress & Growth sub-views (Pillars, Routines, Goals, Achievements)

The current architecture places all content inside `progress.astro` as static hub cards. Instead, each `data-parent-section` should contain the actual page content (pillar list, routine list, etc.).

### Pattern 3: Layout-Level Search Bar Suppression
**What:** When a page uses `UnifiedBar` with search, suppress the global `SearchHub` in Layout
**Implementation:** Add a data attribute or prop to Layout indicating the page handles its own search

### Anti-Patterns to Avoid
- **Double search surfaces** — Never show both global search and page-scoped search
- **Summary→Link→Page** — Don't put a summary card that links away; render inline
- **replaceState for user navigation** — Use pushState for anything the user intentionally clicks

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Hash routing | Custom router | `parent-page-controller` | Already exists, just needs fixes |
| Back button | Custom history stack | Browser History API pushState | Standard, no edge cases |
| Search suppression | Display:none hacks | Layout prop / data attr | Clean, declarative |

## Common Pitfalls

### Pitfall 1: Hash Change Event Loops
**What goes wrong:** `pushState` + `hashchange` listener can cause infinite loops
**How to avoid:** Guard `pushState` with `window.location.hash !== newHash` check

### Pitfall 2: HA Ingress Path Conflicts
**What goes wrong:** Hash links can get mangled by ingress path rewriting
**How to avoid:** Hash-only routing (no path changes) is ingress-safe — confirmed by existing Tasks page behavior

### Pitfall 3: Orphaned Event Listeners
**What goes wrong:** Controller re-init during SPA transitions adds duplicate listeners
**How to avoid:** `parentPageBooted` guard already exists (line 40-42 of controller). Maintain this pattern.

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `parent-page-controller.ts`, `ParentPageShell.astro`, `UnifiedBar.astro`
- Codebase analysis: `progress.astro`, `parent-page-registry.ts`
- MDN History API documentation (standard)

## Metadata

**Confidence breakdown:**
- Architecture: HIGH — codebase already has the right abstractions, just needs adjustment
- Back button fix: HIGH — straightforward History API change
- Search bar: HIGH — Layout has clear prop-passing patterns

**Research date:** 2026-03-21
**Valid until:** Stable — internal architecture patterns
