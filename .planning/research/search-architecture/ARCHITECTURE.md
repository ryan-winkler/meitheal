# Architecture: Search in Meitheal

**Researched:** 2026-03-17

## Current Architecture

```
┌─────────────────────────────────────────────────────┐
│ Client                                               │
│                                                      │
│  ┌──────────────┐     ┌──────────────────────────┐  │
│  │ UnifiedBar   │     │ SearchHub.astro (Cmd+K)  │  │
│  │ inline search│     │ Global search modal      │  │
│  │ (settings    │     │ - Scoped results         │  │
│  │  only)       │     │ - Keyboard nav           │  │
│  └──────┬───────┘     │ - Full result rendering  │  │
│         │             └──────────┬───────────────┘  │
│         │ (direct DOM           │                    │
│         │  filtering)           │ fetch()            │
│         │                       ▼                    │
└─────────┼───────────────────────┼────────────────────┘
          │                       │
          │              ┌────────▼──────────┐
          │              │ /api/search       │
          │              │ GET ?q=&scope=    │
          │              └────────┬──────────┘
          │                       │
          │              ┌────────▼──────────┐
          │              │ searchMeitheal    │
          │              │ Catalog()         │
          │              │ - Tasks (SQLite)  │
          │              │ - Boards          │
          │              │ - Saved filters   │
          │              │ - Settings        │
          │              └──────────────────┘
          │
          ▼
    ┌─────────────────┐
    │ searchSettings  │
    │ Registry()      │
    │ (client-side    │
    │  static match)  │
    └─────────────────┘
```

## Problem: Two Search UX Patterns

**Settings bar search** (`initNavSearch()` in UnifiedBar):
- Client-side only
- Filters settings sections via `searchSettingsRegistry()`
- Results rendered inline as a dropdown below the input
- No task/board/filter results

**SearchHub (Cmd+K)**:
- Full server-side search via `/api/search`
- All scopes: tasks, boards, filters, settings, actions
- Modal overlay with keyboard navigation
- Rich result rendering with sections and badges

These are **two completely different search experiences** that look similar but behave differently.

## Recommended Architecture: Unified Entry

```
┌──────────────────────────────────────────────────────┐
│ Client                                                │
│                                                       │
│  ┌──────────────┐                                     │
│  │ UnifiedBar   │                                     │
│  │ search input │──click/type──▶ Opens SearchHub modal│
│  │ (launcher)   │                 pre-scoped to       │
│  └──────────────┘                 "settings" scope    │
│                                                       │
│  ┌──────────────────────────────────────────────────┐ │
│  │ SearchHub.astro                                   │ │
│  │ - Scope selector (All | Tasks | Settings | etc)  │ │
│  │ - Keyboard nav (↑↓ Enter Esc)                    │ │
│  │ - Cmd+K / `/` to open                            │ │
│  │ - Pre-scoped when opened from settings bar       │ │
│  └───────────────────────┬──────────────────────────┘ │
│                          │ fetch()                     │
│                          ▼                             │
│                 ┌────────────────┐                     │
│                 │ /api/search    │                     │
│                 │ ?q=X&scope=Y   │                     │
│                 └────────┬───────┘                     │
│                          │                             │
│                 ┌────────▼────────┐                    │
│                 │ searchMeitheal  │                    │
│                 │ Catalog()       │                    │
│                 └─────────────────┘                    │
└───────────────────────────────────────────────────────┘
```

### Key Changes

1. **UnifiedBar search input becomes a launcher** — clicking into it opens SearchHub modal pre-scoped to "settings"
2. **Typing in the bar** either opens SearchHub immediately or shows inline results that link to SearchHub
3. **One search implementation** — SearchHub handles all search UX
4. **Settings nav search** (`initNavSearch`) simplified to just focus management + open modal

### Benefits

- No duplicate search logic
- Consistent keyboard navigation
- Consistent result rendering
- Settings-specific results via scope parameter
- Users learn one search paradigm

## HA Integration Considerations

The search bar in the UnifiedBar should work correctly under HA ingress because:
- SearchHub already handles ingress-pathed fetch via Layout.astro's monkey-patched `window.fetch`
- Modal overlay z-indexing works within ingress iframe
- No external search service required (all local SQLite)

## Sources

- Codebase audit: `search-service.ts`, `search-hub-controller.ts`, `settings-shell-controller.ts`
