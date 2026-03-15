# Directory Structure

> Last refreshed: 2026-03-15

## Root Layout

```
meitheal/
├── apps/
│   └── web/                          ← Primary Astro SSR application
├── packages/
│   ├── domain-auth/                  ← Auth/ingress domain logic
│   ├── domain-observability/         ← Structured logging
│   ├── domain-strategy/              ← RICE scoring
│   ├── domain-tasks/                 ← Task type definitions
│   └── integration-core/             ← Calendar/webhook adapters
├── tests/                            ← Playwright E2E + unit tests
├── meitheal-hub/                     ← HA add-on manifest & Docker
├── integrations/                     ← Astro integrations
├── scripts/                          ← Version bump, sync check
├── docs/                             ← ADRs and KCS articles
│   ├── decisions/                    ← Architecture Decision Records
│   └── kcs/                          ← Knowledge-Centered Support articles
├── .planning/                        ← GSD planning artifacts
│   ├── codebase/                     ← This directory (codebase maps)
│   └── research/                     ← Research outputs
├── .agents/                          ← Agent workflows and rules
├── .skills/                          ← Skill definitions
├── .zeroclaw/                        ← Soul/personality config
├── .devcontainer/                    ← Devcontainer for HA testing
├── .github/                          ← CI workflows
└── public/                           ← Static assets, well-known
```

## Apps/Web Detail

```
apps/web/
├── astro.config.mjs                  ← Astro + TW v4 + version injection
├── package.json                      ← @meitheal/web v0.2.13
├── tsconfig.json                     ← Extends ../../tsconfig.base.json
├── scripts/
│   ├── serve.mjs                     ← Ingress-safe HTTP server wrapper
│   ├── migrate.mjs                   ← Database migration runner
│   ├── schema-drift-check.mjs        ← Schema consistency tool
│   └── perf-budget-check.mjs         ← Performance budget enforcement
└── src/
    ├── layouts/
    │   └── Layout.astro              ← Master layout (1255 lines)
    ├── pages/
    │   ├── index.astro               ← Dashboard
    │   ├── kanban.astro              ← Kanban board
    │   ├── table.astro               ← Table view
    │   ├── today.astro               ← Today focus view
    │   ├── upcoming.astro            ← Upcoming tasks
    │   ├── calendar.astro            ← Calendar view
    │   ├── habits.astro              ← Habit tracking
    │   ├── gamification.astro        ← Gamification dashboard
    │   ├── gantt.astro               ← Gantt chart
    │   ├── settings.astro            ← Settings page
    │   ├── offline.astro             ← Offline fallback
    │   ├── 404.astro / 500.astro     ← Error pages
    │   └── api/                      ← 65+ API routes
    │       ├── tasks/                ← CRUD, reorder, create
    │       ├── boards/               ← Board management
    │       ├── labels/               ← Label CRUD
    │       ├── lanes/                ← Kanban lane management
    │       ├── ha/                   ← HA connection, calendars, services
    │       ├── grocy/                ← Grocy integration
    │       ├── integrations/         ← Calendar, Node-RED, status
    │       ├── export/               ← CSV, JSON, ICS, SQLite export
    │       ├── v1/                   ← Vikunja v1 compatibility layer
    │       ├── a2a/                  ← Agent-to-Agent protocol
    │       └── ...                   ← settings, health, features, etc.
    ├── components/                   ← 42 Astro components
    │   ├── layout/                   ← Sidebar, TopNavigation, BoardSwitcher
    │   ├── tasks/                    ← NewTaskModal, StrategicEvaluator
    │   ├── settings/                 ← 7 settings panel components
    │   ├── ui/                       ← 17 reusable UI components
    │   ├── ha/                       ← AskAssistModal, TypingIndicator
    │   ├── gamification/             ← Confetti, Widget, StreakBadge
    │   ├── pomodoro/                 ← PomodoroTimer
    │   └── pwa/                      ← PwaInstallBanner
    ├── lib/                          ← 49 client-side TypeScript modules
    │   ├── *-controller.ts           ← View controllers (kanban, table, settings, etc.)
    │   ├── task-api-client.ts        ← API wrapper for task operations
    │   ├── filter-engine.ts          ← Generic filter engine
    │   ├── filter-state.ts           ← Filter state management
    │   ├── toast.ts                  ← Toast notification system
    │   └── ...                       ← Utilities, sanitization, i18n, etc.
    ├── domains/                      ← In-app domain services
    │   ├── tasks/persistence/        ← Repositories (Task, Board, Lane, Settings, etc.)
    │   ├── auth/                     ← Ingress detection, CSRF
    │   ├── ha/                       ← HA WebSocket, entities, events
    │   ├── calendar/                 ← CalDAV, calendar bridge
    │   ├── todo/                     ← HA todo list sync
    │   ├── ai/                       ← AI context, HA Assist
    │   ├── labels/                   ← Label store, color resolver
    │   ├── habits/                   ← Habit tracking service
    │   ├── pomodoro/                 ← Pomodoro timer service
    │   ├── gamification/             ← Achievement engine, streak tracker
    │   ├── grocy/                    ← Grocy bridge, mapper
    │   ├── offline/                  ← Offline store, sync engine, SW
    │   ├── notifications/            ← Due date reminders
    │   └── integrations/vikunja-compat/ ← Vikunja v1 compatibility
    ├── styles/                       ← 18 CSS files
    │   ├── global.css                ← Entry point (imports all partials)
    │   ├── _tokens.css               ← Design tokens (colors, spacing, etc.)
    │   ├── _base.css                 ← Base/reset styles
    │   ├── _layout.css               ← Sidebar, grid, shell layout
    │   ├── _buttons.css              ← Button component styles
    │   ├── _forms.css                ← Form input styles
    │   ├── _cards.css                ← Card component styles
    │   ├── _modal.css                ← Modal/dialog styles
    │   ├── _kanban.css               ← Kanban-specific styles
    │   ├── _table.css                ← Table view styles
    │   ├── _labels.css               ← Label/badge styles
    │   ├── _tasks.css                ← Task item styles
    │   ├── _search.css               ← Search/command palette
    │   ├── _feedback.css             ← Toast, alerts, feedback
    │   ├── _filter-toolbar.css       ← Filter toolbar styles
    │   ├── _avatar.css               ← Avatar component styles
    │   ├── _responsive.css           ← Responsive breakpoints
    │   └── _utilities.css            ← Utility classes
    ├── middleware.ts                  ← Request pipeline (270 lines)
    ├── i18n/translations.ts          ← Internationalization strings
    └── content.config.ts             ← Content collection config
```

## Tests

```
tests/
├── e2e/                              ← 48 Playwright test specs
│   ├── api.spec.ts                   ← API endpoint tests
│   ├── kanban-backlog-mode.spec.ts   ← Kanban functionality
│   ├── navigation.spec.ts           ← Page navigation
│   ├── accessibility.spec.ts        ← Axe accessibility tests
│   └── ...                           ← Security, ingress, sync, etc.
├── governance/                       ← Governance compliance
│   ├── iqs-platinum.spec.ts
│   └── repo-standards.spec.ts
├── unit/                             ← Unit tests
│   └── todo-status-mapper.spec.ts
└── playwright.config.ts              ← Playwright configuration
```

## Key File Sizes (Lines)

| File | Lines | Notes |
|---|---|---|
| `settings-controller.ts` | 3205 | Largest controller — settings orchestration |
| `task-modal-controller.ts` | 2417 | Task detail modal logic |
| `kanban-controller.ts` | 2019 | Kanban board interactions |
| `table-controller.ts` | 1336 | Table view with sorting/filtering |
| `Layout.astro` | 1255 | Master layout with task modal, sidebar, command palette |
| `layout-controller.ts` | 532 | Sidebar, theme management |
| `middleware.ts` | 270 | Request processing pipeline |
