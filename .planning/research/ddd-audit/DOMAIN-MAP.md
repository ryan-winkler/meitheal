# DDD Audit: Full Codebase Domain Map & Release Readiness

**Project:** Meitheal — Task Management & Strategic Planning Hub
**Audited:** 2026-03-19
**Overall confidence:** HIGH (direct codebase analysis)

## Executive Summary

Meitheal is a DDD monorepo with **4 package-level bounded contexts**, **1 integration package**, and **16 in-app domains**, serving a full-featured task management + life engine via Astro SSR as a Home Assistant add-on. The architecture follows a clear layered separation: pure domain packages (`packages/domain-*`), an integration core (`packages/integration-core`), and in-app domains (`apps/web/src/domains/`). The UI surface spans **14+ distinct pages** with 64+ components, all rendered behind Home Assistant's ingress proxy.

The codebase has grown organically from core task management into a multi-domain application covering gamification, habits, Pomodoro timer, strategic scoring frameworks, AI assistance, calendar/todo sync, grocery management (Grocy), offline-first capabilities, and a Vikunja v1 compatibility layer. Each domain has varying levels of UI maturity — some (Tasks, Kanban) are highly polished while others (Gamification, Habits, Gantt) are MVP-level.

## Complete Domain Inventory (21 Bounded Contexts)

### Tier 1: Package-Level Core Domains (Pure Logic)

| # | Context | Package | Key Types | Responsibility |
|---|---------|---------|-----------|----------------|
| 1 | **domain-auth** | `packages/domain-auth/` | `IngressContext`, `WebAuthnConfig` | Ingress detection, CSRF, session policy, WebAuthn |
| 2 | **domain-tasks** | `packages/domain-tasks/` | `TaskAggregate`, `VerticalSlice`, `HandoffProtocol` | Task aggregate root, domain model, handoff state machine |
| 3 | **domain-strategy** | `packages/domain-strategy/` | `RICEScore`, `RuleType`, `FrameworkConfig` | RICE scoring, rule resolution, strategic framework configs |
| 4 | **domain-observability** | `packages/domain-observability/` | `Logger`, `RedactionPattern` | Structured JSON logging, Loki-compatible output, redaction |

### Tier 2: Integration Package

| # | Context | Package | Adapters | Responsibility |
|---|---------|---------|----------|----------------|
| 5 | **integration-core** | `packages/integration-core/` | `CalendarIntegrationAdapter`, `GrocyAdapter`, `D1Adapter`, `A2AHandler` | Calendar/todo adapters, Grocy bridge, webhook emitter, rate limiter |

### Tier 3: In-App Domains (Application Layer)

| # | Context | Path | Files | UI Surface | Responsibility |
|---|---------|------|-------|------------|----------------|
| 6 | **Tasks** | `domains/tasks/` | 10 | Kanban, Table, Today, Calendar, Gantt, Upcoming, Projects, Review | Persistence (7 repos), recurrence engine, task sync |
| 7 | **Auth** | `domains/auth/` | 2 | Middleware (transparent) | Ingress policy, security headers, CSRF |
| 8 | **HA** | `domains/ha/` | 7 | Settings > HA, AskAssist modal | WebSocket singleton, events, entities, services, users, startup |
| 9 | **Calendar** | `domains/calendar/` | 4 | Calendar page, Settings > Calendar | CalDAV client, bidirectional calendar sync bridge |
| 10 | **Todo** | `domains/todo/` | 3 | Settings > Todo | HA todo list subscription-based real-time sync |
| 11 | **Gamification** | `domains/gamification/` | 3 | Dashboard widget, `/gamification` page | Streak tracking, XP system, achievement engine |
| 12 | **Habits** | `domains/habits/` | 2 | `/habits` page | Daily habit CRUD, completion tracking, streak calculation |
| 13 | **Pomodoro** | `domains/pomodoro/` | 3 | Floating timer widget (global) | Timer state machine (in-memory), session DB persistence |
| 14 | **Strategy** | `domains/strategy/` | 3 | StrategicEvaluator modal, Settings > Rules | Framework overrides, rule repository, custom frameworks |
| 15 | **Labels** | `domains/labels/` | 3 | Label pickers, filter bars, badges | Label store bridging Vikunja compat, color resolution |
| 16 | **Search** | `domains/search/` | 2 | SearchHub modal (⌘K) | Universal search across tasks, settings, boards |
| 17 | **Notifications** | `domains/notifications/` | 2 | Background (push + HA calendar) | Due-date reminder scheduler, eviction-bounded tracking |
| 18 | **Offline** | `domains/offline/` | 8 | `/offline` page, sync indicators | Service worker, IndexedDB, sync engine, tab sync, connectivity |
| 19 | **Grocy** | `domains/grocy/` | 3 | Settings > Grocy | Bidirectional Grocy bridge, chore/task/shopping mapper |
| 20 | **AI** | `domains/ai/` | 2 | AskAssist modal | HA Assist context service, conversation.process proxy |
| 21 | **Vikunja Compat** | `domains/integrations/vikunja-compat/` | 4 | API-only (`/api/v1/*`) | Vikunja v1 REST compatibility (AGPL-only) |

## UI Surface Map

### Pages (14 user-facing + error pages)

| Page | Route | Primary Domains | Key Components |
|------|-------|-----------------|----------------|
| Dashboard | `/` | Tasks, Gamification | EmptyState, LabelBadges, StreakBadge, GamificationWidget |
| Today | `/today` | Tasks, Habits, Gamification | TaskListItem, EmptyState (8 sections: stats, quick-add, filter, carried forward, pinned, due today, unscheduled, suggested) |
| Kanban | `/kanban` | Tasks, Labels | FilterToolbar, CardCustomizer, LabelBadges, StatusBadge, TaskViewTabs |
| Table | `/table` | Tasks, Labels, Strategy | FilterToolbar, ColumnCustomizer, SavedFilterPresets, FrameworkBadge, TaskViewTabs |
| Calendar | `/calendar` | Tasks, Calendar | TaskViewTabs (day grid with event counts + HA event overlay) |
| Gantt | `/gantt` | Tasks | TaskViewTabs (5-week rolling grid, dependency arrows) |
| Upcoming | `/upcoming` | Tasks | EmptyState, LabelBadges (7-day lookahead) |
| Habits | `/habits` | Habits | Feature-flagged, stats bar, habit list, create/edit modal |
| Gamification | `/gamification` | Gamification | GamificationWidget, achievement gallery, heatmap, feature-flagged |
| Projects | `/projects` | Tasks (hierarchy) | Project cards with goal breadcrumbs, progress bars |
| Project Detail | `/projects/[id]` | Tasks (hierarchy) | Task list within project context |
| Review | `/review` | Tasks (handoff) | Bot proposal diff review queue |
| Settings | `/settings` | All domains | 7 sections, 16+ Astro components, UnifiedBar tabs |
| Offline | `/offline` | Offline | Static fallback page |

### Global Layout Components (always loaded via Layout.astro)

| Component | Domain | Purpose |
|-----------|--------|---------|
| Sidebar | Layout | Navigation, board switching, hierarchy tree, task counts |
| TopNavigation | Layout | Mobile top bar |
| SearchHub | Search | ⌘K universal search modal |
| TaskDetailModal | Tasks | Full task detail view/edit overlay |
| NewTaskModal | Tasks | Quick task creation modal |
| StrategicEvaluator | Strategy | RICE/framework scoring modal |
| AskAssistModal | AI | HA Assist conversation modal |
| PomodoroTimer | Pomodoro | Floating timer widget |
| Confetti | Gamification | Celebration animation on completion |
| PwaInstallBanner | Offline/PWA | PWA install prompt |

### API Routes (97+ endpoints)

| Domain | Count | Endpoints |
|--------|-------|-----------|
| Tasks | 15 | CRUD, reorder, clear/delete completed, proposals, time tracking |
| Projects/Goals/Areas | 6 | Hierarchy CRUD |
| Boards/Lanes | 4 | Board management, lane customization |
| HA | 8 | Connection, events, services, addons, agents, assist, calendars, status |
| Todo | 3 | Sync, items, index |
| Calendar | 3 | CalDAV credentials, sync, confirmation |
| Grocy | 5 | Stock, auto-key, settings, test, sync |
| Strategy | 6 | Rules CRUD, defaults, resolve, frameworks CRUD/export |
| Gamification | 1 | Stats + data |
| Habits | 1 | CRUD |
| Pomodoro | 1 | Timer state + control |
| Search | 1 | Universal search |
| Labels | 2 | CRUD |
| Settings | 1 | Key-value settings |
| Export | 5 | Tasks (ICS, JSON, CSV), settings, database |
| Backup | 2 | Prepare, complete |
| Users | 3 | Default, custom, index |
| Integrations | 6 | Webhook, n8n, NodeRED, status |
| A2A/MCP | 3 | Agent card, message, tasks |
| Vikunja v1 | 5 | Projects, tasks, labels, users, assignees |
| Misc | 6 | Health, features, SSE, parse-task, unfurl, NFC |

## Sub-Agent Audit Plan

Each group below receives a dedicated persona-panel audit examining UI/UX, ADHD-friendliness, accessibility, DDD boundary health, and release readiness.

| Sub-Agent | Domains | Pages Covered | Critical Questions |
|-----------|---------|---------------|-------------------|
| **SA-1: Core Task Views** | Tasks (persistence + package) | Dashboard, Today, Kanban, Table, Upcoming, Review | Is the core task loop polished? Quick-add, status transitions, bulk operations? |
| **SA-2: Hierarchy & Projects** | Tasks (hierarchy repos) | Projects index, Project detail, Goals, Areas | Is project organization intuitive? Goal→Project→Task flow clear? |
| **SA-3: Calendar & Time** | Calendar, Pomodoro | Calendar page, timer widget | Is date-centric planning effective? Timer UX smooth? |
| **SA-4: Gamification & Habits** | Gamification, Habits | Gamification page, Habits page | Are engagement features motivating without being distracting? |
| **SA-5: Strategy & Labels** | Strategy (pkg + app), Labels | StrategicEvaluator, Settings>Rules, label UI | Is RICE scoring accessible? Framework management clear? |
| **SA-6: HA Integration** | HA, Todo, Notifications | Settings>HA, AskAssist, background sync | Is HA integration robust? Error states clear? |
| **SA-7: External Integrations** | Grocy, Calendar Sync, Vikunja, N8n | Settings>Integrations subsections | Are third-party connections reliable? Setup friction low? |
| **SA-8: Search & AI** | Search, AI | SearchHub, AskAssist | Is search fast and comprehensive? AI assistance useful? |
| **SA-9: Offline & PWA** | Offline domain | Offline page, sync indicators | Is offline experience seamless? Conflict resolution clear? |
| **SA-10: Auth & Infrastructure** | Auth, Observability, Middleware | Middleware flow, security headers | Are security boundaries correct? Logging sufficient? |
| **SA-11: Layout & Shell** | Layout, Sidebar, Settings, Shared UI | All pages (chrome), Settings | Is navigation intuitive? Settings discoverable? |
