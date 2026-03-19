# Codebase Structure — Meitheal

> Last refreshed: 2026-03-19

## Top-Level Layout

```
meitheal/
├── apps/
│   ├── web/                    # Astro SSR app (primary)
│   └── api/                    # Legacy API (unused)
├── packages/
│   ├── domain-auth/            # Ingress, CSRF (37 lines)
│   ├── domain-observability/   # Structured logging (222 lines)
│   ├── domain-strategy/        # RICE, rules (674 lines)
│   ├── domain-tasks/           # Task domain model (716 lines)
│   └── integration-core/      # Adapters: A2A, CalDAV, Grocy, HA, webhooks (1855 lines)
├── integrations/
│   ├── home-assistant/         # Apache-2.0 — HA API client boundary
│   ├── nodered/                # Apache-2.0 — Node-RED flows
│   └── blueprints/             # HA blueprints
├── meitheal-hub/               # HA add-on config (config.yaml, run.sh, rootfs, translations)
├── tests/
│   ├── e2e/                    # 60+ spec files
│   ├── governance/             # IQS + repo standards
│   └── unit/                   # Unit tests
├── docs/
│   ├── decisions/              # ADRs
│   ├── kcs/                    # KCS runbooks
│   └── methodologies/          # Process docs
├── .planning/
│   ├── codebase/               # ← these files
│   ├── phases/                 # GSD phase plans
│   ├── research/               # Research & audits
│   └── STATE.md                # Current project state
├── .agents/workflows/          # GSD workflow definitions
├── .skills/core-workflows/     # Skill definitions
└── .zeroclaw/                  # Agent soul/personality
```

## apps/web/src/ — Primary Application

### Pages (15 files, 11,406 lines total)

| File | Lines | Description |
|------|-------|-------------|
| `kanban.astro` | 1877 | Kanban board with lanes, drag-and-drop, grouping |
| `today.astro` | 1410 | Daily task view with habits, stats, flow |
| `eisenhower.astro` | 1337 | 2×2 urgency/importance matrix |
| `habits.astro` | 1162 | Habit tracker with streaks |
| `table.astro` | 1030 | Data grid with sort, filter, columns |
| `calendar.astro` | 917 | Monthly calendar with HA events |
| `index.astro` | 883 | Dashboard overview |
| `upcoming.astro` | 715 | Next 7 days task view |
| `settings.astro` | 577 | Settings shell |
| `gamification.astro` | 542 | XP, streaks, achievements |
| `review.astro` | 393 | Weekly review |
| `gantt.astro` | 391 | Timeline/Gantt view |

### Controllers (28 files, 16,528 lines total)

| File | Lines | Description |
|------|-------|-------------|
| `task-modal-controller.ts` | 2522 | Task detail/edit modal |
| `kanban-controller.ts` | 2063 | Kanban board logic |
| `today-controller.ts` | 1548 | Today page logic |
| `table-controller.ts` | 1352 | Table view logic |
| `eisenhower-controller.ts` | 999 | Eisenhower matrix logic (standalone) |
| `habits-controller.ts` | 907 | Habit tracking |
| `page-shell-controller.ts` | 258 | Shared shell: tabs, scroll spy, overflow |
| `unified-bar-controller.ts` | 186 | Bar: title, search, new task, tabs |

### Components (65 files, 16,105 lines total)

Key directories:
- `layout/` — UnifiedBar, Sidebar, SearchHub, TopNavigation
- `tasks/` — TaskListItem, TaskDetailModal, NewTaskModal, TaskViewTabs, StrategicEvaluator
- `settings/` — 15 settings panel components
- `ui/` — FilterToolbar, CardCustomizer, ColumnCustomizer, BotBadge
- `ha/` — AskAssistModal, TypingIndicator
- `gamification/` — Confetti, GamificationWidget, StreakBadge
- `pomodoro/` — PomodoroTimer
- `pwa/` — PwaInstallBanner

### Domains (16 directories)

| Domain | Key files | Purpose |
|--------|-----------|---------|
| `auth/` | `ingress-policy.ts`, `ingress.ts` | HA ingress auth |
| `ha/` | `ha-connection.ts`, `ha-events.ts`, `ha-services.ts` | HA WebSocket bridge |
| `tasks/` | `task-repository.ts`, `task-sync-service.ts` | Task persistence |
| `calendar/` | `caldav-client.ts`, `calendar-bridge.ts` | Calendar sync |
| `search/` | `search-service.ts` | Universal search |
| `offline/` | `sw-register.ts`, `sync-engine.ts`, `offline-store.ts` | PWA/offline |
| `todo/` | `todo-bridge.ts`, `todo-status-mapper.ts` | HA todo sync |
| `strategy/` | `rule-repository.ts`, `framework-repository.ts` | Strategic frameworks |
| `gamification/` | `achievement-engine.ts`, `streak-tracker.ts` | XP system |
| `habits/` | `habit-service.ts` | Habit CRUD |
| `pomodoro/` | `pomodoro-service.ts` | Timer logic |
| `grocy/` | `grocy-bridge.ts`, `grocy-mapper.ts` | Grocery integration |
| `labels/` | `label-store.ts`, `label-color-resolver.ts` | Label management |
| `notifications/` | `due-date-reminders.ts` | Push notifications |
| `ai/` | `ai-context-service.ts`, `ha-assist-service.ts` | AI/LLM integration |
| `integrations/` | `vikunja-compat/` | Vikunja API compat layer |

### API Routes (100+ files)

Organized under `apps/web/src/pages/api/`:
- `/api/tasks/` — CRUD, reorder, proposals, time tracking
- `/api/ha/` — connection, calendars, events, services, agents
- `/api/integrations/` — calendar sync, n8n, nodered
- `/api/settings.ts` — flat key-value settings
- `/api/search.ts` — universal search
- `/api/labels.ts`, `/api/areas/`, `/api/goals/`, `/api/projects/` — hierarchy
- `/api/v1/` — Vikunja compat API

### i18n

Two locale files:
- `apps/web/src/i18n/en.json` — English (primary)
- `apps/web/src/i18n/ga.json` — Irish (Gaeilge)
