# Architecture

> Last refreshed: 2026-03-15

## Pattern

**DDD monorepo** with Astro SSR web app + shared domain packages + event-driven HA integration.

```
meitheal/
├── apps/web/          ← Astro SSR application (the product)
├── packages/          ← Shared domain logic (pure TS)
├── tests/             ← Standalone Playwright test workspace
├── meitheal-hub/      ← HA add-on manifest + Docker config
├── integrations/      ← Astro integrations
├── scripts/           ← Build/deploy helpers
└── .planning/         ← GSD planning artifacts
```

## Layers (Top → Bottom)

### 1. Presentation Layer — `apps/web/src/pages/`

Astro pages serve SSR HTML. Two categories:
- **View pages** (11): `index.astro`, `kanban.astro`, `table.astro`, `today.astro`, `upcoming.astro`, `calendar.astro`, `habits.astro`, `gamification.astro`, `gantt.astro`, `settings.astro`, `offline.astro`
- **API routes** (65+): Under `pages/api/` — RESTful endpoints for tasks, boards, labels, settings, integrations, export, HA, etc.
- **Error pages**: `404.astro`, `500.astro`

### 2. Component Layer — `apps/web/src/components/`

42 Astro components organized by domain:
- `layout/` — Sidebar, TopNavigation, BoardSwitcher, SidebarFooter, SidebarNavList
- `tasks/` — NewTaskModal, StrategicEvaluator, TaskViewTabs
- `settings/` — SettingsGeneral, SettingsLabels, SettingsIntegrations, SettingsSystem, SettingsAgents, SettingsShellNav, SettingsSummaryCard
- `ui/` — Reusable: Icon, StatusBadge, PriorityLabel, TaskTypeIcon, LabelPicker, FilterToolbar, EmptyState, Skeleton, RiceBadge, etc.
- `ha/` — AskAssistModal, TypingIndicator
- `gamification/` — Confetti, GamificationWidget, StreakBadge
- `pomodoro/` — PomodoroTimer
- `pwa/` — PwaInstallBanner

### 3. Client Controller Layer — `apps/web/src/lib/`

49 TypeScript modules. Heavy client-side logic:
- **View controllers** (largest files):
  - `settings-controller.ts` (3205 lines) — Settings page orchestration
  - `task-modal-controller.ts` (2417 lines) — Task detail modal logic
  - `kanban-controller.ts` (2019 lines) — Kanban board interactions, drag/drop, lanes
  - `table-controller.ts` (1336 lines) — Table view with sorting, filtering
  - `layout-controller.ts` (532 lines) — Sidebar, theme, layout state
  - `dashboard-controller.ts` (247 lines) — Dashboard widget management
- **Infrastructure libs**: `safe-fetch.ts`, `toast.ts`, `ingress-fetch.ts`, `filter-engine.ts`, `filter-state.ts`, `task-api-client.ts`, `focus-trap.ts`, `validation.ts`, `rate-limit.ts`, etc.

### 4. Domain Layer — `apps/web/src/domains/`

In-app domain services (16 modules across 11 bounded contexts):
- `tasks/persistence/` — TaskRepository, BoardRepository, LaneRepository, SettingsRepository, TemplateRepository, UserRepository, store
- `auth/` — `ingress.ts`, `ingress-policy.ts`
- `ha/` — `ha-connection.ts`, `ha-entities.ts`, `ha-events.ts`, `ha-services.ts`, `ha-users.ts`, `ha-startup.ts`
- `calendar/` — `calendar-bridge.ts`, `caldav-client.ts`, `resolve-calendar-entities.ts`
- `todo/` — `todo-bridge.ts`, `todo-status-mapper.ts`
- `ai/` — `ai-context-service.ts`, `ha-assist-service.ts`
- `labels/` — `label-store.ts`, `label-color-resolver.ts`
- `habits/` — `habit-service.ts`
- `pomodoro/` — `pomodoro-service.ts`, `pomodoro-types.ts`
- `gamification/` — `achievement-engine.ts`, `streak-tracker.ts`
- `grocy/` — `grocy-bridge.ts`, `grocy-mapper.ts`
- `offline/` — `offline-store.ts`, `sync-engine.ts`, `sw-register.ts`, `connectivity.ts`, `tab-sync.ts`, `sync-lock.ts`
- `notifications/` — `due-date-reminders.ts`
- `integrations/vikunja-compat/` — v1 API compatibility layer

### 5. Shared Domain Packages — `packages/`

Pure TypeScript, no framework dependencies:
- `domain-auth/` — Ingress detection, CSRF, session policy
- `domain-tasks/` — Task type definitions, vertical slice exports
- `domain-strategy/` — RICE scoring, strategic lens framework
- `domain-observability/` — Structured JSON logging, redaction, audit
- `integration-core/` — Calendar adapter interfaces, HA bridge, webhook emitter, A2A handler, rate limiter

### 6. Infrastructure

- **Middleware** (`apps/web/src/middleware.ts`, 270 lines): Rate limiting, CSRF, security headers, ingress path rewriting, DB schema init, HA integration init
- **Ingress wrapper** (`apps/web/scripts/serve.mjs`): HTTP server normalizing `//` → `/`, injecting `X-Ingress-Path` header before Astro processes requests
- **HA add-on config** (`meitheal-hub/config.yaml`): Defines the Home Assistant add-on manifest

## Data Flow

```
Browser → [HA Ingress Proxy] → serve.mjs (normalize //) → Astro middleware
  → Security (CSRF, CSP, rate limit) → Route handler → TaskRepository → SQLite
  ← SSR HTML | JSON response ← Browser
```

Client-side: Layout.astro monkey-patches `window.fetch()` to auto-prefix API calls with the ingress path.

## Key Entry Points

| Entry | File | Purpose |
|---|---|---|
| Web app | `apps/web/src/layouts/Layout.astro` (1255 lines) | Master layout — sidebar, task modal, command palette, all global UI |
| Server entry | `apps/web/scripts/serve.mjs` | HTTP server with ingress normalization |
| Middleware | `apps/web/src/middleware.ts` | Request processing pipeline |
| DB | `apps/web/src/domains/tasks/persistence/store.ts` | Database singleton |
| HA connection | `apps/web/src/domains/ha/ha-connection.ts` | WebSocket to HA |
