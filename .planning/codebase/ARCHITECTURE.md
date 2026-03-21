# Architecture — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Pattern

**DDD Monorepo** with Astro SSR + domain packages + event-driven integration.

```
┌─────────────────────────────────┐
│           Astro SSR             │  apps/web/
│    (Pages, API routes, UI)      │
├────────────┬────────────────────┤
│  Domains   │   Lib/Controllers  │  src/domains/, src/lib/
├────────────┴────────────────────┤
│      Workspace Packages         │  packages/domain-*/, integration-core/
├─────────────────────────────────┤
│  SQLite (libsql) + HA APIs      │  Persistence + External
└─────────────────────────────────┘
```

## Layers

### 1. Pages (Entry Points)
`apps/web/src/pages/` — Astro `.astro` pages + API routes (`.ts`)

- **UI Pages:** `index.astro`, `tasks.astro`, `kanban.astro`, `calendar.astro`, `today.astro`, `upcoming.astro`, `eisenhower.astro`, `progress.astro`, `planning.astro`, `settings.astro`, `habits.astro`, `timeline.astro`, `review.astro`, `gamification.astro`, `table.astro`
- **Entity Pages:** `pillars/[id].astro`, `pillars/index.astro`, `areas/[id].astro`, `projects/[id].astro`, `goals/index.astro`
- **API Routes:** 95+ endpoints under `/api/` — REST pattern with Astro APIRoute handlers
- **Error Pages:** `404.astro`, `500.astro`

### 2. Components
`apps/web/src/components/` — Astro components organized by domain:

| Directory | Content |
|-----------|---------|
| `layout/` | Layout shell, TopNavigation, Sidebar, ParentPageShell, UnifiedBar, SearchHub, SectionHubCard |
| `tasks/` | TaskCard, TaskModal, TaskTable, TaskTimeline, task list views |
| `pillars/` | PillarCard, PillarFormModal, PillarSelector |
| `views/` | TasksKanbanView, TasksTableView, TasksTimelineView |
| `settings/` | All settings panels (theme, AI, integrations, data, danger zone) |
| `ui/` | Reusable: InlineHelper, InlineDatePicker, ColorPicker, IconPicker, CardCustomizer |
| `shared/` | SharedColorPicker, SharedIconPicker |
| `gamification/` | Achievement, streak, XP components |
| `ha/` | HA connection status, entity widgets |
| `pomodoro/` | Pomodoro timer widget |
| `pwa/` | Install prompts, offline indicators |

### 3. Domains (In-App)
`apps/web/src/domains/` — Each domain is a bounded context with its own service files:

| Domain | Files | Responsibility |
|--------|-------|---------------|
| `ai/` | 2 | AI context injection, HA Assist service |
| `auth/` | 2 | Ingress policy, ingress detection |
| `calendar/` | 4 | CalDAV client, HA calendar bridge |
| `gamification/` | 3 | Achievement engine, streak tracker |
| `grocy/` | 3 | Grocy bridge, mapper |
| `ha/` | 7 | WebSocket, entities, events, services, users, startup |
| `habits/` | 2 | Habit/routine CRUD service |
| `labels/` | 3 | Label store, color resolution |
| `notifications/` | 3 | Due date reminders |
| `offline/` | 8 | Connectivity, sync engine, tab sync, SW registration |
| `pillars/` | 3 | Pillar CRUD, principles, associations |
| `pomodoro/` | 3 | Pomodoro timer service |
| `search/` | 2 | Search service, types |
| `strategy/` | 4 | Custom frameworks, rules |
| `tasks/` | 2 | Recurrence, task sync |
| `todo/` | 3 | HA todo bridge, status mapping |
| `integrations/` | N/A | Vikunja v1 compat layer |

### 4. Lib (Controllers + Utilities)
`apps/web/src/lib/` — 90+ files following the controller pattern:

- **Page controllers:** `dashboard-controller.ts`, `kanban-controller.ts`, `table-controller.ts`, `timeline-controller.ts`, etc.
- **Shell controllers:** `page-shell-controller.ts`, `parent-page-controller.ts`, `settings-shell-controller.ts`
- **Registries:** Enum-like config files (`dashboard-registry.ts`, `calendar-registry.ts`, `settings-registry.ts`, etc.)
- **Common utilities:** `toast.ts`, `focus-trap.ts`, `managed-listeners.ts`, `page-lifecycle.ts`, `safe-fetch.ts`
- **API client:** `task-api-client.ts`, `task-queries.ts`

### 5. Workspace Packages
`packages/` — Pure domain logic, no framework dependencies:

| Package | Entry | Key Exports |
|---------|-------|-------------|
| `domain-auth` | `src/index.ts` | `verifyLicenseKey()`, CSRF utils, ingress detection |
| `domain-observability` | `src/index.ts`, `src/logger.ts` | Structured JSON logger with redaction |
| `domain-strategy` | `src/index.ts` | RICE scoring, rule resolver, framework config |
| `domain-tasks` | `src/index.ts` | Domain model, handoff state machine, vertical slice |
| `integration-core` | `src/index.ts` | Calendar adapters, A2A handler, webhook emitter, rate limiter |

## Data Flow

```
Browser → Astro Page (SSR) → Domain Service → SQLite (libsql)
                  ↓
          API Route (REST) → Domain Service → SQLite
                  ↓
         Client Controller → fetch() → API Route
```

### Ingress Flow (HA)
```
HA Frontend → iframe → serve.mjs (// normalization)
    → middleware.ts (ingress rewrite, CSP, CSRF)
    → Astro Page → Layout.astro (fetch monkey-patch for API calls)
```

## Key Abstractions

| Abstraction | Pattern | Example |
|-------------|---------|---------|
| **Page Controller** | `pageLifecycle.onLoad()` → init function | `dashboard-controller.ts` |
| **Registry** | Static config objects for page-specific settings | `dashboard-registry.ts` |
| **Domain Service** | `ensure*Schema()` + CRUD functions | `pillar-service.ts` |
| **Persistence Client** | `getPersistenceClient()` → raw SQL via libsql | All domain services |
| **API Response** | `{ ok: true, data }` / `{ ok: false, errorCode }` | All API routes |
| **Managed Listeners** | `createListenerManager()` for cleanup | `managed-listeners.ts` |

## Middleware Pipeline

`apps/web/src/middleware.ts` (322 lines):
1. Ingress path detection from `X-Ingress-Path` header
2. CSRF token validation
3. Rate limiting per IP
4. CSP header injection
5. HTML attribute rewriting (href, src with ingress prefix)

## i18n

| File | Purpose |
|------|---------|
| `apps/web/src/i18n/en.json` | English translations |
| `apps/web/src/i18n/ga.json` | Irish translations |
| `apps/web/src/i18n/translations.ts` | `t()` helper function with locale detection from cookie |

Locale set via `meitheal-locale` cookie. Default: `en`.

## Styles Architecture

`apps/web/src/styles/` — Modular CSS with `@import` in `global.css`:

| Module | Scope |
|--------|-------|
| `_tokens.css` | Design tokens (CSS custom properties) |
| `_base.css` | Reset, body, typography |
| `_buttons.css` | Button variants |
| `_cards.css` | Card components |
| `_forms.css` | Form elements |
| `_modal.css` | Modal dialog styles |
| `_layout.css` | Page layout grid |
| `_responsive.css` | Breakpoints |
| `_page-shell.css` | PageShell component |
| `_parent-page.css` | ParentPageShell |
| `_kanban.css` | Kanban board |
| `_table.css` | Data table |
| `_tasks.css` | Task cards |
| `_search.css` + `_search-hub.css` | Search UI |
| `_labels.css` | Label tags |
| `_filter-toolbar.css` | Filter toolbar |
| `_feedback.css` | Toast, alerts |
| `_avatar.css` | User avatars |
| `_utilities.css` | Utility classes |
| `timeline-gantt.css` | Gantt chart |
| `inline-date-picker.css` | Date picker |
