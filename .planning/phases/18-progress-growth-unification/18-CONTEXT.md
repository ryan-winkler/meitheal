# Phase 18: Progress & Growth Unification — Context

**Created:** 2026-03-21
**Author:** Ryan + Antigravity

## Decisions

1. **Remove old/duplicate search bar** — The unified bar from Tasks is the canonical search surface. The old `Search Meitheal...` topbar search must go from Progress & Growth pages
2. **Kill "Open North Star →"** pattern — Each sub-page (Pillars, Routines, Goals, Achievements) should render inline in the Progress & Growth shell, not behind a summary card with a link
3. **Fix browser back button** — Hash-based navigation must use `pushState` not `replaceState` so back/forward works
4. **Fix click handler conflicts** — Parent page controller and sub-page controllers must not fight each other for events
5. **Unified search scoped to Progress & Growth** — Search launcher on the bar should be scoped to the current parent page and its sub-views
6. **Astro islands, HA integration, AI/MCP compatibility** — All components must work behind HA ingress, respect island hydration, and expose APIs for automation

## Claude's Discretion

- How to handle the inline rendering of sub-pages (lazy load, SSR sections, dynamic import)
- Whether to keep the standalone routes (`/pillars`, `/habits`, `/goals`, `/gamification`) as redirects or remove entirely
- Controller extraction strategy for the unified bar

## Deferred Ideas

- AI-powered search suggestions
- Voice search integration
- Real-time sync with HA entity states in search results
