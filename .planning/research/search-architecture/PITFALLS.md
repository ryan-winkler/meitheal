# Pitfalls: Search Architecture

**Researched:** 2026-03-17

## Critical Pitfalls

### Pitfall 1: Adopting Static Search for Dynamic Data
**What goes wrong:** Pagefind indexes HTML at build time. Meitheal's tasks are created/modified at runtime in SQLite. A static index would never include user data.
**Why it happens:** Pagefind is popular in the Astro ecosystem and feels like a natural choice. But Meitheal is SSR, not SSG.
**Consequences:** Search would only find static page content (help text, settings labels), not actual tasks. Users would think search is broken.
**Prevention:** Keep server-side SQLite search. Only consider pagefind if adding a static docs site.
**Detection:** Tasks not appearing in search results.

### Pitfall 2: Two Search UX Patterns
**What goes wrong:** UnifiedBar has inline settings search; SearchHub has full search modal. Users encounter different behavior depending on where they search.
**Why it happens:** Settings nav search was built independently from SearchHub.
**Consequences:** Inconsistent UX, duplicated code, users confused about what's searchable from where.
**Prevention:** Unify: make the UnifiedBar search input a launcher for SearchHub, pre-scoped to settings.

### Pitfall 3: Search Results "Not Contained"
**What goes wrong:** The inline search results dropdown in UnifiedBar can extend outside the bar, overlap with content, or not have proper visual containment.
**Why it happens:** `position: relative` on search container + `position: absolute` on results, but results div has no max-height, no proper background, or extends beyond viewport.
**Consequences:** Results overlap with settings content, visual breakage on small screens.
**Prevention:** If keeping inline results: proper containment, max-height, scroll, backdrop. Better approach: open SearchHub modal instead.

## Moderate Pitfalls

### Pitfall 4: HA Quality Scale Checklist Misapplication
**What goes wrong:** Applying HA core integration quality scale rules to a Supervisor add-on.
**Why it happens:** The checklist at `developers.home-assistant.io/docs/core/integration-quality-scale/checklist` is for **core integrations** (`custom_components/` or built-in), not for Supervisor add-ons.
**Consequences:** Wasted effort implementing `config-flow`, `entity-unique-id`, `has-entity-name` etc. that don't apply to add-ons.
**Prevention:** Meitheal is a Supervisor add-on (web app in Docker). Follow add-on publishing guidelines instead: `config.yaml`, `repository.yaml`, image architecture naming.
**What IS relevant from the checklist:**
- `docs-high-level-description` ✓
- `docs-installation-instructions` ✓
- `docs-removal-instructions` — should add
- `docs-troubleshooting` — should add
- `docs-known-limitations` — should add

### Pitfall 5: Search Debounce Missing
**What goes wrong:** Every keystroke fires an API request to `/api/search`.
**Why it happens:** No debounce on input handler.
**Consequences:** N×API calls for single query, server load, jarring results flashing.
**Prevention:** 200-300ms debounce on search input.

## Minor Pitfalls

### Pitfall 6: No Search Analytics
**What goes wrong:** No way to know what users search for.
**Prevention:** Optional structured log of search queries (anonymized) via domain-observability.

## Sources

- Codebase audit
- Pagefind docs (Context7)
- HA developer docs (quality scale checklist)
