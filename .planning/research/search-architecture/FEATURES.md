# Feature Landscape: Search in Meitheal

**Researched:** 2026-03-17

## Table Stakes

Features users expect in a task management search system.

| Feature | Why Expected | Complexity | Status |
|---------|--------------|------------|--------|
| Task search by title | Core functionality | Low | ✅ Done |
| Full-text search (description, comments) | Users remember content, not titles | Medium | ✅ Done |
| Keyboard shortcut (Cmd+K) | Power user expectation | Low | ✅ Done |
| Scope filtering (tasks, settings, boards) | Reduce noise | Medium | ✅ Done |
| Result ranking by relevance | Most relevant first | Medium | ✅ Done (scoring system) |
| Settings search | Find specific settings | Low | ✅ Done (registry-based) |

## Differentiators

| Feature | Value Proposition | Complexity | Status |
|---------|-------------------|------------|--------|
| HA entity search | Search HA entities from search hub | High | ❌ Not started |
| Natural language search | "my overdue tasks" → filtered view | High | ❌ Not started (needs AI) |
| Search result highlighting | Bold matched terms | Low | ❌ Not done |
| Recent searches | Quick re-access to common queries | Low | ❌ Not done |
| Saved searches as filters | Search → saved filter workflow | Medium | ✅ Partially (saved filters exist, not from search) |
| Cross-page search from any page | Search hub accessible everywhere | Low | ✅ Done (SearchHub in Layout) |

## Anti-Features

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Pagefind static indexing | SSR + SQLite dynamic data — would only index static chrome | Keep SQLite FTS |
| External search service (MeiliSearch, Typesense) | Adds infrastructure to HA add-on | SQLite FTS is sufficient |
| Client-side full dataset loading | Performance/memory on large task sets | Server-side search via API |
| Separate search per page | Inconsistent UX | Unified SearchHub modal |

## Feature Dependencies

```
SearchHub modal ← Unified search entry point
  ↑
UnifiedBar search launcher → opens SearchHub pre-scoped
  ↑
Search result highlighting → enhances both inline and modal results
  ↑
Recent searches → localStorage, enhances SearchHub
```

## MVP Recommendation (Iteration 03)

Prioritize:
1. Fix search CSS containment in UnifiedBar (visual bug)
2. Unify search entry points (bar input → opens SearchHub pre-scoped)
3. Add search debounce (200ms)
4. Add result term highlighting

Defer:
- HA entity search (needs WebSocket integration complexity)
- Natural language search (needs AI backend)
- Search analytics (nice-to-have)
