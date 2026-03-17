# Technology Stack: Search Architecture

**Project:** Meitheal Search
**Researched:** 2026-03-17

## Current Stack (Correct — Keep)

### Core Search
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| SQLite FTS | via Drizzle ORM | Full-text search on tasks, descriptions, comments | Dynamic data, SSR — build-time indexing impossible |
| `/api/search` | Astro API route | Server-side search endpoint | Scoped queries, auth, rate limiting |
| `searchMeithealCatalog()` | N/A | Unified search orchestrator | Searches tasks, boards, filters, settings from one function |
| `SearchHub.astro` | N/A | Global search modal (Cmd+K) | Full-featured, keyboard-driven, scoped results |
| `search-hub-controller.ts` | N/A | Client-side search modal controller | Handles open/close, keyboard nav, result rendering |
| `settings-registry.ts` | N/A | Settings-specific search catalog | Static registry searchable by label, description, keywords |

## Alternatives Evaluated

| Category | Evaluated | Recommended | Why Not / Why |
|----------|-----------|-------------|---------------|
| Static search | Pagefind (astro-pagefind) | ❌ Not suitable | Build-time HTML indexing — doesn't work for SSR dynamic data (tasks from SQLite) |
| Astro tooling | inox-tools | ❌ Not relevant | Utility collection (cut shortcodes, referencing, stubs) — not a search solution |
| Full-text engine | MeiliSearch / Typesense | ❌ Over-engineered | Adds infrastructure dependency to a HA add-on — SQLite FTS is sufficient for scale |
| Browser-side search | Fuse.js | ❌ Wrong layer | Client-side fuzzy search requires downloading all data — breaks with large task sets |

## Why Pagefind Does Not Fit

**HIGH confidence** (Context7 verified, official docs checked)

Pagefind works by:
1. Crawling static HTML output at `build` time
2. Building a WASM-powered search index from `data-pagefind-body` elements
3. Serving the index as static files to the browser

Meitheal's data is:
- **Dynamic** — tasks are created/updated/deleted at runtime
- **Server-rendered** — SSR mode, not static build
- **Database-backed** — SQLite, not HTML files
- **Scoped** — search has auth context, scopes, filters

Pagefind would only work on *static content* (docs pages, help text). Task search requires the existing server-side approach.

## Recommended Improvements (No Stack Changes)

| Improvement | What | Why |
|-------------|------|-----|
| Unify search entry points | Settings bar search should open `SearchHub` modal (Cmd+K) | One search UX, not two independent search implementations |
| Debounce + cache | Add 200ms debounce to search API calls, LRU cache on client | Reduce unnecessary API calls during typing |
| Search result highlighting | Bold matched terms in results | Better information scent |
| Recent searches | Store last 5 searches in localStorage | Quick re-access |

## Sources

- Pagefind documentation via Context7 (`/pagefind/pagefind`) — HIGH confidence
- astro-pagefind GitHub via Context7 (`/shishkin/astro-pagefind`) — HIGH confidence
- inox-tools GitHub README — directly verified, no search functionality
- Meitheal source code audit — `search-service.ts`, `search-hub-controller.ts`, `/api/search.ts`
