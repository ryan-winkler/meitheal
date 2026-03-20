# Codebase Structure — Meitheal

> Last refreshed: 2026-03-20 (Phase 16 — Task Views Overhaul)

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

### Pages (18 files, ~10,800 lines total)

| File | Lines | Description |
|------|-------|-------------|
| `tasks.astro` | 1767 | **Kanban board** — lanes, drag-and-drop, grouping (canonical `/tasks` route) |
| `eisenhower.astro` | 1425 | 2×2 urgency/importance matrix (standalone shell) |
| `today.astro` | 1297 | Daily task view with habits, stats, flow |
| `habits.astro` | 1164 | Habit tracker with streaks |
| `index.astro` | 883 | Dashboard overview |
| `table.astro` | 787 | Data grid with sort, filter, columns |
| `calendar.astro` | 678 | Monthly calendar with HA events |
| `settings.astro` | 577 | Settings shell |
| `upcoming.astro` | 540 | Next 7 days task view |
| `gamification.astro` | 544 | XP, streaks, achievements |
| `planning.astro` | 444 | Strategic planning view |
| `timeline.astro` | 426 | Timeline/Gantt view (renamed from gantt in Phase 16) |
| `review.astro` | 393 | Weekly review |
| `progress.astro` | 122 | Progress dashboard |
| `kanban.astro` | 17 | **301 redirect → /tasks** (Phase 16 route consolidation) |

### Controllers (~28 files)

| File | Lines | Description |
|------|-------|-------------|
| `task-modal-controller.ts` | 2522 | Task detail/edit modal |
| `kanban-controller.ts` | 1657 | Kanban board logic (decomposed in Phase 16) |
| `table-controller.ts` | 1012 | Table view logic |
| `today-controller.ts` | 934 | Today page logic |
| `habits-controller.ts` | 907 | Habit tracking |
| `settings-rules-controller.ts` | 757 | Settings rules |
| `framework-wizard-controller.ts` | 659 | Framework wizard |
| `eisenhower-controller.ts` | 654 | Eisenhower matrix logic (standalone) |
| `page-shell-controller.ts` | ~258 | Shared shell: tabs, scroll spy, overflow |
| `unified-bar-controller.ts` | ~186 | Bar: title, search, new task, view pills |

**Kanban sub-controllers (Phase 16 decomposition):**
- `controllers/kanban-touch-drag.ts` — mobile drag-and-drop
- `controllers/kanban-lane-panel.ts` — lane management panel
- `controllers/kanban-quick-actions.ts` — quick actions popover

### Components (68 files)

Key directories:
- `layout/` — UnifiedBar, Sidebar, SearchHub, TopNavigation, ParentPageShell, SidebarHierarchyTree
- `tasks/` — TaskListItem, TaskDetailModal, NewTaskModal, StrategicEvaluator, TaskViewTabs (orphaned)
- `settings/` — 15 settings panel components
- `ui/` — FilterToolbar, CardCustomizer, ColumnCustomizer, BotBadge
- `ha/` — AskAssistModal, TypingIndicator
- `gamification/` — Confetti, GamificationWidget, StreakBadge
- `pomodoro/` — PomodoroTimer
- `pwa/` — PwaInstallBanner

### Registries (9 files)

| File | Description |
|------|-------------|
| `calendar-registry.ts` | Calendar section definitions |
| `dashboard-registry.ts` | Dashboard section definitions |
| `eisenhower-registry.ts` | Eisenhower section definitions |
| `habits-registry.ts` | Habits section definitions |
| `parent-page-registry.ts` | Cross-page navigation + subViews |
| `settings-registry.ts` | Settings sections + search metadata |
| `table-registry.ts` | Table section definitions |
| `today-registry.ts` | Today section definitions |
| `upcoming-registry.ts` | Upcoming section definitions |

> **Note:** `kanban-registry.ts` was deleted in Phase 16 — kanban sections now live directly in `tasks.astro`.

### Domains (16 directories)

| Domain | Key files | Purpose |
|--------|-----------|---------
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
