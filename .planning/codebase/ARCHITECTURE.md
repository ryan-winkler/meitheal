# Codebase Architecture — Meitheal

> Last refreshed: 2026-03-20 (Phase 16 — Task Views Overhaul)

## Pattern

**DDD monorepo with Astro SSR + domain packages + event-driven integration**

```
┌─────────────────────────────────────────────────────┐
│                   Astro SSR (apps/web)              │
│                                                     │
│  ┌─────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │  Pages   │→ │  Layout  │→ │  Components      │   │
│  │  (SSR)   │  │ + Shell  │  │  (Astro + CSS)   │   │
│  └────┬─────┘  └────┬─────┘  └──────────────────┘   │
│       │              │                               │
│  ┌────▼─────┐  ┌────▼──────────────────────┐        │
│  │ API Routes│  │  Controllers (vanilla JS)  │       │
│  │ /api/*    │  │  *-controller.ts + registries│     │
│  └────┬─────┘  └──────────────────────────────┘      │
│       │                                              │
│  ┌────▼─────────────────────────────────────┐        │
│  │         In-App Domains                    │       │
│  │  auth, ha, todo, tasks, search,           │       │
│  │  calendar, gamification, habits,          │       │
│  │  grocy, labels, notifications,            │       │
│  │  offline, pomodoro, strategy, ai          │       │
│  └──────────────────────────────────────────┘        │
└──────────────────────┬──────────────────────────────┘
                       │ workspace:*
┌──────────────────────▼──────────────────────────────┐
│              Workspace Packages                      │
│  domain-auth │ domain-tasks │ domain-strategy        │
│  domain-observability │ integration-core             │
└─────────────────────────────────────────────────────┘
```

## Layers

### 1. Pages (SSR Entry Points)
**Path:** `apps/web/src/pages/`
18 page files. Each page:
- Fetches data server-side (SSR)
- Renders Astro components
- Embeds a `<script>` block calling its controller function
- Uses `Layout.astro` with `slot="custom-header"` for UnifiedBar

**Route consolidation (Phase 16):** Kanban content moved to `/tasks` route. `/kanban` is now a 301 redirect. `/gantt` renamed to `/timeline`.

**Largest pages:** tasks (1767), eisenhower (1425), today (1297), habits (1164), index (883)

### 2. Layout Shell
**Path:** `apps/web/src/layouts/Layout.astro` (~630 lines)
- Master layout with sidebar, topnav, unified bar slot
- Client-side fetch monkey-patch for ingress prefix
- View transitions disabled behind ingress

### 3. Controllers (Client-Side Logic)
**Path:** `apps/web/src/lib/*-controller.ts`
~28 controller files.

**Controller hierarchy:**
```
layout-controller.ts (global)
├── layout-body-controller.ts
├── layout-pwa-controller.ts
├── layout-shortcuts-controller.ts
│
page-shell-controller.ts (shared shell behavior)
├── today-controller.ts → initPageShellNavigation
├── upcoming-controller.ts → initPageShellNavigation
├── calendar-controller.ts → initPageShellNavigation
├── kanban-controller.ts → initPageShellNavigation (drives /tasks)
├── table-controller.ts → initPageShellNavigation
│
kanban-controller.ts sub-modules:
├── controllers/kanban-touch-drag.ts
├── controllers/kanban-lane-panel.ts
├── controllers/kanban-quick-actions.ts
│
unified-bar-controller.ts (bar-specific logic)
├── consumed by page-shell-controller
├── consumed by dashboard-controller
├── consumed by habits-controller
├── consumed by settings-shell-controller
│
eisenhower-controller.ts (STANDALONE — no shared shell)
```

### 4. Components
**Path:** `apps/web/src/components/`
68 Astro components across: `gamification/`, `ha/`, `layout/`, `pomodoro/`, `pwa/`, `settings/`, `tasks/`, `ui/`

**Key layout components:**
- `UnifiedBar.astro` (597 lines) — reusable navigation bar with viewTabs pill support
- `Sidebar.astro` (~473 lines) — main navigation
- `SearchHub.astro` — command palette search overlay

**Deprecated components:**
- `TaskViewTabs.astro` — orphaned after Phase 16 (view switching moved to UnifiedBar pills)

### 5. Navigation: View Pills (Phase 16)
Task view switching is now handled by UnifiedBar's `viewTabs` prop:
- Pill-shaped buttons rendered between title switcher and section tabs
- Query-string preservation on view switch
- Active state with solid background highlight
- Responsive: horizontal scroll on mobile

Views: Kanban (`/tasks`) → Table (`/table`) → Calendar (`/calendar`) → Timeline (`/timeline`)

### 6. In-App Domains
**Path:** `apps/web/src/domains/`
16 domain directories with domain services, bridges, and repositories.

### 7. API Layer
**Path:** `apps/web/src/pages/api/`
100+ API route files covering tasks, HA, integrations, settings, labels, search, etc.

### 8. Middleware
**Path:** `apps/web/src/middleware.ts` (~322 lines)
- Ingress rewriting (HTML href/src attributes)
- CSP headers, CSRF protection, rate limiting
- Request logging

### 9. Ingress Wrapper
**Path:** `apps/web/scripts/serve.mjs` (~70 lines)
- HTTP server normalizing `//` → `/` for HA ingress

## Data Flow

```
Browser → serve.mjs (path normalization)
       → middleware.ts (ingress rewrite, CSP, CSRF)
       → Astro page (SSR render, data fetch)
       → Layout.astro (shell, sidebar, fetch monkey-patch)
       → Page controller (client-side JS)
       → API routes (/api/*) → domain services → SQLite/HA
```

## Key Abstractions

| Abstraction | Location | Consumer |
|------------|----------|----------|
| `pageLifecycle` | `lib/page-lifecycle.ts` | All controllers — lifecycle hooks |
| `initPageShellNavigation` | `lib/page-shell-controller.ts` | 5/6 task page controllers |
| Section registries | `lib/*-registry.ts` | Page + controller pairs |
| `UnifiedBarViewTab` | `UnifiedBar.astro` interface | 4 task view pages |
| `task-api-client.ts` | `lib/task-api-client.ts` | All task CRUD operations |
| `managed-listeners.ts` | `lib/managed-listeners.ts` | Event listener cleanup |
| `filter-state.ts` | `lib/filter-state.ts` | Shared filter/sort state |
