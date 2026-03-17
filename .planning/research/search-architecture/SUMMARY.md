# Research Summary: Search Architecture for Meitheal

**Domain:** Task management & strategic planning search (HA add-on)
**Researched:** 2026-03-17
**Overall confidence:** HIGH

## Executive Summary

Meitheal's search architecture is **fundamentally correct**. The server-side SQLite FTS approach via `/api/search` + `searchMeithealCatalog()` is the right pattern for an SSR Astro app with dynamic data stored in SQLite. The global `SearchHub.astro` modal (Cmd+K) provides a solid search experience with scoped results, keyboard navigation, and rich rendering.

The user's question about Pagefind and astro-pagefind has a clear answer: **Pagefind is incompatible with Meitheal's architecture.** Pagefind indexes static HTML at build time — Meitheal's task data is dynamic, runtime-created, and stored in SQLite. Pagefind would only index the static UI chrome (settings labels, page titles), not actual user data. Similarly, inox-tools is an Astro utilities collection (cut shortcodes, referencing, stubs) with no search functionality.

The HA Integration Quality Scale checklist the user referenced applies to **core integrations** (Python-based custom components), not Supervisor add-ons. However, the documentation quality principles (high-level description, installation/removal instructions, troubleshooting, known limitations) are worth adopting for Meitheal's add-on README and docs.

The **actual problem** is that the UnifiedBar search input creates a **second, disconnected search experience** from the SearchHub modal. The settings bar search uses client-side registry matching while SearchHub uses full server-side search. The recommended fix: make the UnifiedBar search input a **launcher** for SearchHub, pre-scoped to "settings".

## Key Findings

**Stack:** SQLite FTS is correct. Pagefind/external engines are wrong fits.
**Architecture:** Two disconnected search UX patterns need unification via SearchHub.
**Critical pitfall:** Adopting static-build search for dynamic SSR data.

## Implications for Roadmap

Based on research, suggested execution:

1. **Fix CSS containment** — The "not contained" search results issue is purely CSS
   - Addresses: visual bug user reported
   - Low effort, high impact

2. **Unify search entry points** — Make UnifiedBar search a launcher for SearchHub
   - Addresses: dual search UX, inconsistent behavior
   - Medium effort, high impact

3. **Search polish** — Debounce, result highlighting, recent searches
   - Addresses: UX quality
   - Low effort, medium impact

4. **HA documentation alignment** — Adopt quality scale doc principles for add-on docs
   - Addresses: publishing readiness
   - Low effort, high impact for community

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack (keep SQLite) | HIGH | Context7 verified pagefind is build-time only |
| Architecture (unify search) | HIGH | Codebase audit confirms dual implementation |
| Pagefind rejection | HIGH | Official docs + Context7 confirm SSR incompatibility |
| HA quality scale | HIGH | Checklist page explicitly says "core integrations" |
| inox-tools rejection | HIGH | GitHub README reviewed — no search features |

## Gaps to Address

- Whether SearchHub modal should support "scope=settings" as a URL parameter for deep linking
- Whether search results should include HA entities via WebSocket in the future
- Search analytics/observability requirements
