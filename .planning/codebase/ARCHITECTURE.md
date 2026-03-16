# Architecture

**Analysis Date:** 2026-03-16

## Pattern Overview

**Overall:** Domain-Driven Design (DDD) monorepo with Astro SSR

**Key Characteristics:**
- Strict bounded contexts: domain packages (`packages/domain-*`) + in-app domains (`apps/web/src/domains/`)
- Server-side rendered pages with progressive client-side enhancement (module scripts, focused inline scripts, and `ClientRouter` in standalone mode)
- Event-driven HA integration via WebSocket
- HTTP wrapper (`serve.mjs`) normalizes requests before Astro processes them
- Middleware chain handles auth, CSP, CSRF, rate limiting, HTML rewriting

## Layers

**Domain Packages (`packages/`):**
- Purpose: Pure domain logic shared across apps. No framework dependencies.
- Location: `packages/domain-auth/`, `packages/domain-tasks/`, `packages/domain-strategy/`, `packages/domain-observability/`, `packages/integration-core/`
- Contains: Type definitions, business rules, interfaces
- Depends on: Nothing (standalone)
- Used by: `apps/web/` via workspace imports (`@meitheal/domain-*`)

**In-App Domains (`apps/web/src/domains/`):**
- Purpose: Application-specific domain logic tightly coupled to Astro/HA runtime
- Location: `apps/web/src/domains/{ai,auth,calendar,gamification,grocy,ha,habits,integrations,labels,notifications,offline,pomodoro,search,strategy,tasks,todo}/`
- Contains: Bridge services, persistence, sync engines, HA adapters, universal search orchestration
- Depends on: Domain packages, `@lib/*`, HA WebSocket API
- Used by: Pages, API routes, middleware

**Presentation Layer (`apps/web/src/pages/`):**
- Purpose: Astro pages (SSR) rendering HTML + mounting client scripts
- Location: `apps/web/src/pages/*.astro`
- Contains: `index.astro`, `kanban.astro`, `table.astro`, `today.astro`, `upcoming.astro`, `calendar.astro`, `habits.astro`, `gamification.astro`, `gantt.astro`, `settings.astro`, `tasks.astro`, `offline.astro`
- Depends on: Domains, lib, components, layouts
- Used by: Browser (end-user)
- Note: `settings.astro` now renders a grouped shell with search, summaries, and hash deep-links instead of hidden tab panes.

**API Layer (`apps/web/src/pages/api/`):**
- Purpose: REST endpoints for client-side fetch, external integrations (MCP, A2A, NFC), webhooks
- Location: `apps/web/src/pages/api/` (30+ route files across 15 subdirectories)
- Contains: Task CRUD, board management, label management, backup/export, universal search, HA proxy, SSE, Vikunja compat
- Depends on: Domains, lib
- Used by: Client-side controllers, external agents

**Component Layer (`apps/web/src/components/`):**
- Purpose: Reusable Astro components (server-rendered)
- Location: `apps/web/src/components/{ui,layout,settings,ha,tasks,gamification,pomodoro,pwa}/`
- Contains: `FilterToolbar.astro`, `TaskTypeIcon.astro`, `StatusBadge.astro`, `Sidebar.astro`, `TopNavigation.astro`, `SearchHub.astro`, `SettingsShellNav.astro`, etc.
- Depends on: Lib utilities
- Used by: Pages

**Client Controllers (`apps/web/src/lib/`):**
- Purpose: Client-side TypeScript modules for page interactivity
- Location: `apps/web/src/lib/` (50+ modules)
- Contains: `kanban-controller.ts` (2,019 lines), `table-controller.ts` (1,336), `task-modal-controller.ts` (2,417), `search-hub-controller.ts`, `dashboard-controller.ts`
- Depends on: Browser APIs, `@domains/offline/`, `@lib/task-api-client.ts`
- Used by: Pages via `<script>` imports
- **Settings controllers** (Phase 08.2 decomposition from monolithic 3,205 LoC file):
  - `settings-controller.ts` (~120 LoC coordinator, re-exports sub-controllers)
  - `settings-theme-controller.ts`, `settings-sidebar-controller.ts`, `settings-integrations-controller.ts`, `settings-ai-controller.ts`, `settings-data-controller.ts`, `settings-danger-controller.ts`
  - Composition: `settings-page.ts` → `settings-shell-controller.ts` + `settings-store.ts` + `settings-registry.ts`
- Phase 08.1 shared settings primitives (`SettingsSectionIntro`, `SettingsPanelCard`, `SettingsCallout`, `SettingsActionRow`, `SettingsDisclosure`, `SettingsStatusChip`) provide one visual language across all panels.

**Middleware (`apps/web/src/middleware.ts`):**
- Purpose: Request pipeline — auth, security headers, CSRF, rate limiting, HTML rewriting for ingress
- Location: `apps/web/src/middleware.ts`
- Depends on: `@domains/auth/`, `@meitheal/domain-observability`, `@domains/tasks/persistence/`, `@domains/ha/`

**Ingress Wrapper (`apps/web/scripts/serve.mjs`):**
- Purpose: HTTP server normalizing `//` paths, injecting `X-Ingress-Path` header
- Location: `apps/web/scripts/serve.mjs`
- Depends on: Node.js `http` module, `INGRESS_PATH` env var

## Data Flow

**Task CRUD:**
1. User action → client controller (e.g., `task-modal-controller.ts`)
2. Client calls `@lib/task-api-client.ts` → `fetch()` to `/api/tasks`
3. API route validates with Zod → calls `TaskRepository`
4. `TaskRepository` → Drizzle ORM → SQLite
5. Optional: Webhook dispatch, SSE broadcast, HA todo sync

**HA Integration:**
1. `middleware.ts` → `initHAIntegrations()` on first request
2. `ha-startup.ts` establishes WebSocket via `home-assistant-js-websocket`
3. `ha-services.ts` wraps HA service calls
4. `todo-bridge.ts` syncs tasks ↔ HA todo entities
5. `calendar-bridge.ts` syncs tasks ↔ HA calendar entities

**Page Rendering (SSR):**
1. Request → `serve.mjs` (normalize) → Astro middleware
2. Middleware resolves ingress context, builds security headers
3. Astro SSR renders page with data from `TaskRepository`
4. Layout.astro monkey-patches `fetch()` for ingress prefix
5. Client controllers hydrate interactivity

**Universal Search:**
1. `SearchHub.astro` renders the shared overlay shell and static page/action/settings registries
2. `search-hub-controller.ts` manages keyboard launch, focus trap, scopes, and selection
3. `/api/search` delegates to `@domains/search/search-service.ts`
4. `search-service.ts` fans out to `TaskRepository`, `BoardRepository`, `SettingsRepository`, and the shared settings registry
5. Search results deep-link back into ingress-safe pages and settings hashes

**State Management:**
- Server: SQLite via Drizzle ORM (single source of truth)
- Client: `@domains/offline/offline-store.ts` (IndexedDB for offline)
- Sync: `@domains/offline/sync-engine.ts` (background sync + conflict resolution)
- Tab coordination: `@domains/offline/tab-sync.ts`
- Settings shell: `settings-store.ts` caches `/api/settings` reads and preserves existing persisted keys while the shell manages summaries, quick jumps, detail-mode state, deep links, and companion actions client-side.
- Search hub: `SearchHub.astro` ships a static registry for pages/actions/settings while `/api/search` supplies live task/board/filter results.

## Key Abstractions

**TaskRepository:**
- Purpose: CRUD + query for tasks
- Location: `@domains/tasks/persistence/task-repository.ts`
- Pattern: Repository pattern over Drizzle ORM

**Bridge Services:**
- Purpose: Bidirectional sync between Meitheal tasks and external systems
- Examples: `@domains/todo/todo-bridge.ts`, `@domains/calendar/calendar-bridge.ts`, `@domains/grocy/grocy-bridge.ts`
- Pattern: Adapter (maps external API → domain model)

**Client Controllers:**
- Purpose: Page-specific client-side interactivity
- Examples: `@lib/kanban-controller.ts`, `@lib/table-controller.ts`, `@lib/task-modal-controller.ts`
- Pattern: Imperative DOM manipulation (no framework — Astro-native)

**Discriminated Union Results:**
- Pattern: `{ ok: true, data } | { ok: false, errorCode }` for all API responses
- Used in: API routes, lib modules

## Entry Points

**HTTP Server:**
- Location: `apps/web/scripts/serve.mjs`
- Triggers: `node serve.mjs` (via `meitheal-hub/run.sh`)
- Responsibilities: URL normalization, ingress header injection, Astro handler delegation

**Astro Dev Server:**
- Location: `apps/web/astro.config.mjs`
- Triggers: `pnpm dev` / `astro dev`
- Responsibilities: HMR, SSR, Vite plugins

**Middleware:**
- Location: `apps/web/src/middleware.ts`
- Triggers: Every HTTP request
- Responsibilities: Auth, rate limiting, CSP, CSRF, HTML rewriting

## Error Handling

**Strategy:** Discriminated unions for API layer, try/catch with structured logging elsewhere

**Patterns:**
- API routes return `{ ok: false, errorCode: string }` — never throw
- `@lib/safe-fetch.ts` wraps `fetch()` with error normalization
- Logger redacts secrets via `defaultRedactionPatterns`
- `@lib/toast.ts` for client-side error notification

## Cross-Cutting Concerns

**Logging:** `@meitheal/domain-observability` — structured JSON, Loki-compatible, auto-redaction
**Validation:** Zod schemas in API routes
**Authentication:** HA Supervisor token + ingress context resolution
**Rate Limiting:** In-memory map in middleware (300 req/min/IP, capped entries)
**Security Headers:** CSP, CSRF, X-Frame-Options, Referrer-Policy via `ingress-policy.ts`

---

*Architecture analysis: 2026-03-16*
