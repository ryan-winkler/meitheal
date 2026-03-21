# Phase 16: Tasks Layout Redesign - Research

**Researched:** 2026-03-21
**Domain:** Astro SSR client-side view switching, HA ingress hash routing, progressive filter UX
**Confidence:** HIGH

## Summary

Phase 16 unifies 4 separate Astro task view pages (`/tasks`, `/table`, `/calendar`, `/timeline`) into a single `/tasks` page with client-side hash-based view switching. This is a proven pattern already used by the Settings page (`/settings` with hash-based sections). The existing `parent-page-registry.ts` already defines tasks as a parent page with hash sub-views — the implementation makes the registry's promise real.

The primary technical challenge is managing SSR data fetching for 4 views in one page without bloating initial response. The recommended approach is to SSR all views (each as an Astro component with its own frontmatter data fetching) and use CSS `display:none` to toggle visibility — this ensures zero loading spinners on view switch while keeping each view's content SSR'd for SEO and initial render.

**Primary recommendation:** Use the Settings page pattern — SSR all view components, hash-based switching with `history.replaceState`, lazy controller initialization via `meitheal:view-changed` custom event.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Astro | 5.x (current) | SSR framework | Already in use, powers the entire app |
| `<script>` tags | N/A | Client-side hash routing | Astro scripts run client-side by default, no framework needed |
| `history.replaceState` | Web API | Hash updates without scroll jump | Native browser API, zero dependencies |
| `hashchange` event | Web API | React to hash changes (back/forward) | Native, works behind HA ingress |
| `localStorage` | Web API | Persist last-used view, filter state | Already used for settings persistence |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pageLifecycle` | Internal | Controller lifecycle management | Already in use for all page controllers |
| `AbortSignal` | Web API | Cleanup event listeners | Already used in kanban-controller, calendar-controller |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| SSR all views | Lazy fetch on view switch | Adds loading spinners, breaks instant switch feel |
| hash routing | query params (`?view=table`) | Breaks HA ingress (query params cause 301 loops in some configs) |
| CSS display toggle | DOM removal/insertion | Loses scroll position, re-initializes controllers |

## Architecture Patterns

### Recommended Project Structure
```
src/
├── pages/
│   ├── tasks.astro              # Unified host — imports all views
│   ├── table.astro              # 301 redirect → /tasks#table
│   ├── calendar.astro           # 301 redirect → /tasks#calendar
│   ├── timeline.astro           # 301 redirect → /tasks#timeline
│   └── kanban.astro             # 301 redirect → /tasks#kanban (already exists)
├── components/views/
│   ├── TasksTableView.astro     # Extracted table view component
│   ├── TasksCalendarView.astro  # Extracted calendar view component
│   └── TasksTimelineView.astro  # Extracted timeline view component
├── lib/
│   └── tasks-view-controller.ts # Client-side hash switching logic
```

### Pattern 1: Astro Component-Level Data Fetching
**What:** Each view component (`TasksTableView.astro`) does its own server-side data fetching in its frontmatter, keeping data concerns localized.
**When to use:** When multiple views need different data but share a page layout.
**Example:**
```astro
---
// TasksTableView.astro — owns its own data
import { getTasksForView } from "../lib/task-queries"
const { tasks, counts } = await getTasksForView()
---
<div id="tasks-view-table" style="display:none" aria-hidden="true">
  <!-- table content -->
</div>
```

### Pattern 2: Hash-Based View Switching (Settings Pattern)
**What:** Same pattern as `/settings` — hash changes swap visibility, controllers lazy-initialize.
**When to use:** Multi-view pages where all data can be SSR'd.
**Example:**
```typescript
// tasks-view-controller.ts
window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#", "")
  switchView(view) // CSS display toggle + event dispatch
})
```

### Pattern 3: Ingress-Safe 301 Redirects
**What:** Legacy pages return `Astro.redirect()` with ingress path prefix.
**When to use:** Converting route-level pages to hash-based views.
**Example:**
```astro
---
const { ingressPath } = Astro.locals
const qs = new URL(Astro.request.url).searchParams.toString()
const q = qs ? `?${qs}` : ''
return Astro.redirect(`${ingressPath || ""}/tasks#table${q}`, 301)
---
```

### Anti-Patterns to Avoid
- **Don't double-prefix API calls** — `Layout.astro` already monkey-patches `window.fetch` with ingress prefix
- **Don't use `window.location.href` for hash changes** — causes page reload. Use `history.replaceState`
- **Don't lazy-load view content via fetch** — SSR is better for instant switching
- **Don't use query params for view state** — HA ingress can cause 301 redirect loops with query params

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| View switching | Custom SPA router | Simple hash + display toggle | Hash routing is native, works behind ingress |
| Controller lifecycle | Custom init tracking | `pageLifecycle.onPageLoad()` + `meitheal:view-changed` event | Already proven pattern in codebase |
| Filter persistence | Custom persistence layer | Existing `localStorage` + `meitheal:filter-change` events | Filter events already wired |
| Redirect logic | Custom middleware | `Astro.redirect()` with ingress prefix | Already proven by `kanban.astro` |

## Common Pitfalls

### Pitfall 1: HA Ingress Hash Handling
**What goes wrong:** Hash fragments don't get sent to server, so ingress path extraction works differently for hash-based routing.
**Why it happens:** HA ingress rewrites the top-level URL but hash is client-only.
**How to avoid:** Hash routing is actually ingress-SAFE because hashes never leave the browser. The ingress path is already in the page URL. Hash changes don't trigger new requests.
**Warning signs:** If you see 301 redirect loops when switching views, you're accidentally navigating to a new route instead of changing the hash.

### Pitfall 2: SSR Data Bloat
**What goes wrong:** Rendering all 4 views server-side increases page size.
**Why it happens:** Calendar and Timeline views include substantial HTML for grids/bars.
**How to avoid:** Each view component renders its own block. The HTML increase is acceptable because Astro compresses well and there's no duplicate data fetching (each component queries only what it needs). Monitor via `pnpm build` output sizes.
**Warning signs:** Page load time > 2s on local dev.

### Pitfall 3: Controller Double-Initialization
**What goes wrong:** View controllers initialize twice when switching views rapidly.
**Why it happens:** `meitheal:view-changed` fires on every switch but controllers don't check if already initialized.
**How to avoid:** Track initialized views in a `Set<string>`, pass `firstInit: boolean` in the event detail, controller only bootstraps on `firstInit: true`.
**Warning signs:** Duplicate event listeners, cards respond twice to clicks.

### Pitfall 4: View-Specific Filter State Conflicts
**What goes wrong:** Kanban filter state (group-by type) bleeds into Table view.
**Why it happens:** FilterToolbar emits generic events that all views listen to.
**How to avoid:** Scope filter events per view, or have the view controller gate filter application to the active view only.
**Warning signs:** Switching from Kanban (grouped by type) to Table shows grouped table.

## Code Examples

### Verified: Astro.redirect() with status code (Context7 HIGH)
```astro
---
// Source: Astro official docs — redirect()
return Astro.redirect("/tasks#table", 301)
---
```

### Verified: Hash change event listener (Web API HIGH)
```typescript
window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#", "")
  // Switch view
}, { signal }) // AbortSignal for cleanup
```

### Existing codebase pattern: Settings page hash routing
```typescript
// settings-page.ts (already in codebase)
// Uses hash-based section switching with history.replaceState
// Same pattern will be reused for tasks view switching
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate route per view | Single page + hash switching | Phase 16 | Eliminates page reloads, preserves filter state |
| Route-level `viewTabs` | Hash-based `data-view-tab` buttons | Phase 16 | Context preserved across view switches |
| Monolithic FilterToolbar | Same for now (decomposed in 16.3) | Phase 16.3 | Progressive disclosure reduces cognitive load |

## Sources

### Primary (HIGH confidence)
- Context7 `/withastro/docs` — Astro redirect API, client script handling, islands architecture
- Existing codebase: `settings-page.ts`, `kanban.astro` redirect, `parent-page-registry.ts`

### Secondary (MEDIUM confidence)
- Existing E2E tests: `kanban-shell.spec.ts` — confirms current view switching patterns

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all native Web APIs + existing Astro patterns
- Architecture: HIGH — replicating proven Settings page pattern
- Pitfalls: HIGH — identified from existing codebase experience (ingress issues, double-init)

**Research date:** 2026-03-21
**Valid until:** 2026-04-21 (stable — Astro SSR patterns don't change frequently)
