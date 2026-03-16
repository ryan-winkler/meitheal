# Codebase Structure

**Analysis Date:** 2026-03-16

## Directory Layout

```
meitheal/
├── apps/
│   ├── api/                    # Cloudflare Workers API (legacy/secondary)
│   └── web/                    # Main Astro SSR application
│       ├── .astro/             # Astro build cache (gitignored)
│       ├── .data/              # Runtime data directory
│       ├── dist/               # Production build output
│       ├── drizzle/            # Drizzle ORM schema & migrations
│       │   └── migrations/     # SQL migration files
│       ├── public/             # Static assets (styles/, .well-known/)
│       ├── scripts/            # Build/runtime scripts (serve.mjs, migrate.mjs, bump-version.mjs)
│       └── src/
│           ├── components/     # Astro components (server-rendered)
│           │   ├── gamification/
│           │   ├── ha/         # Home Assistant UI components
│           │   ├── layout/     # Sidebar, TopNavigation, SearchHub
│           │   ├── pomodoro/
│           │   ├── pwa/
│           │   ├── settings/   # Settings shell primitives + section panels
│           │   │   └── integrations/  # Integration sub-components (HA, Calendar, Todo, etc.)
│           │   ├── tasks/
│           │   └── ui/         # Shared UI (FilterToolbar, StatusBadge, TaskTypeIcon, etc.)
│           ├── content/        # Astro content collections (frameworks)
│           ├── domains/        # In-app domain modules
│           │   ├── ai/         # LLM/Assist integration
│           │   ├── auth/       # Ingress auth, CSRF
│           │   ├── calendar/   # Calendar sync bridge
│           │   ├── gamification/
│           │   ├── grocy/      # Grocy integration
│           │   ├── ha/         # HA WebSocket, services, events
│           │   ├── habits/
│           │   ├── integrations/ # Vikunja compat layer
│           │   ├── labels/     # Label management
│           │   ├── notifications/
│           │   ├── offline/    # IndexedDB, sync, SW
│           │   ├── pomodoro/
│           │   ├── search/     # Universal search orchestration
│           │   ├── strategy/   # RICE scoring
│           │   ├── tasks/      # Task persistence, sync
│           │   └── todo/       # HA todo list sync
│           ├── i18n/           # Internationalization
│           ├── layouts/        # Layout.astro (main layout)
│           ├── lib/            # Client controllers & utilities (50+ modules)
│           ├── pages/          # Astro pages + API routes
│           │   └── api/        # REST API (15+ subdirectories, including search)
│           └── styles/         # CSS partials (18 files)
├── meitheal-hub/               # HA add-on packaging
│   ├── config.yaml             # Add-on manifest (version source of truth)
│   ├── Dockerfile              # Multi-arch Docker build
│   ├── run.sh                  # Add-on entrypoint
│   ├── llm_api.py              # Python LLM API for HA
│   └── DOCS.md                 # User-facing add-on documentation
├── packages/                   # Domain packages (pure logic)
│   ├── domain-auth/            # Auth interfaces & CSRF
│   ├── domain-observability/   # Structured logger
│   ├── domain-strategy/        # RICE scoring engine
│   ├── domain-tasks/           # Task aggregate & types
│   └── integration-core/       # Adapter interfaces & impls
├── tests/                      # Test package (@meitheal/tests)
│   ├── e2e/                    # 48 E2E spec files
│   ├── governance/             # 2 governance spec files
│   ├── unit/                   # 1 unit spec file
│   └── scripts/                # Test utilities
├── scripts/                    # Root-level build scripts
├── .agents/                    # Agent rules & workflows
├── .planning/                  # GSD planning docs
│   ├── codebase/               # THIS directory
│   ├── phases/                 # Phase planning documents
│   └── research/               # Research outputs
├── .github/workflows/ci.yml    # CI pipeline
├── .coderabbit.yaml            # CodeRabbit config
└── pnpm-workspace.yaml         # Monorepo workspace definition
```

## Directory Purposes

**`apps/web/src/domains/`:**
- Purpose: Application-specific domain logic bound to Astro/HA runtime
- Contains: Bridge services, persistence layers, sync engines
- Key files: `ha/ha-startup.ts`, `tasks/persistence/store.ts`, `todo/todo-bridge.ts`
- Each domain has an `index.ts` barrel export

**`apps/web/src/lib/`:**
- Purpose: Client-side controllers (page interactivity) and shared utilities
- Contains: Page controllers (kanban, table, settings, task-modal), API client, filter engine, toast, validation
- Key files: `kanban-controller.ts` (2,019 LoC), `task-modal-controller.ts` (2,417 LoC), `search-hub-controller.ts`
- **Settings controllers** (decomposed from monolithic 3,205 LoC file, all using `pageLifecycle.on()` + `escapeHtml()`):
  - `settings-controller.ts` (~160 LoC coordinator, re-exports)
  - `settings-theme-controller.ts` (appearance/theme)
  - `settings-sidebar-controller.ts` (navigation layout)
  - `settings-integrations-ha-controller.ts` (HA connection, webhooks)
  - `settings-integrations-n8n-controller.ts` (n8n/Node-RED integration)
  - `settings-integrations-grocy-controller.ts` (Grocy inventory)
  - `settings-integrations-sync-controller.ts` (calendar/todo sync)
  - `settings-ai-controller.ts` (agent & AI config)
  - `settings-data-controller.ts` (import/export/backup/custom fields)
  - `settings-danger-controller.ts` (purge/reset)
  - `settings-shell-controller.ts`, `settings-store.ts`, `settings-registry.ts`, `settings-page.ts`
- **Shared utilities:** `page-lifecycle.ts` (event listener lifecycle management via AbortController), `safe-html.ts` (XSS prevention), `toast.ts`, `confirm-dialog.ts`

**`apps/web/src/components/ui/`:**
- Purpose: Reusable Astro UI components
- Contains: `FilterToolbar.astro` (640 LoC), `StatusBadge.astro`, `TaskTypeIcon.astro`, `EmptyState.astro`, `LabelPicker.astro`

**`apps/web/src/components/settings/`:**
- Purpose: Settings shell navigation, summaries, shared UX primitives, and grouped section panels
- Contains: `SettingsShellNav.astro`, `SettingsSummaryCard.astro`, `SettingsSectionIntro.astro`, `SettingsPanelCard.astro`, `SettingsCallout.astro`, `SettingsActionRow.astro`, `SettingsDisclosure.astro`, `SettingsStatusChip.astro`, `SettingsGeneral.astro`, `SettingsIntegrations.astro` (1,403 LoC, composes 6 sub-components), `SettingsAgents.astro`, `SettingsLabels.astro`, `SettingsSystem.astro`
- **`integrations/`** subdirectory: `IntegrationHA.astro`, `IntegrationCalendar.astro`, `IntegrationTodo.astro`, `IntegrationGrocy.astro`, `IntegrationN8n.astro`, `IntegrationWebhooks.astro`

**`apps/web/src/styles/`:**
- Purpose: CSS design system via partials
- Contains: `_tokens.css` (design tokens), `_base.css`, `_buttons.css`, `_cards.css`, `_forms.css`, `_kanban.css` (578 LoC), `_table.css` (551 LoC), `_responsive.css` (536 LoC), `_modal.css`, `_layout.css`
- Entry: `global.css` imports all partials

**`packages/`:**
- Purpose: Pure domain logic packages — no framework dependencies
- Contains: Type definitions, business rules, adapter interfaces
- Key files: `domain-tasks/src/task.ts` (aggregate), `domain-strategy/src/rice.ts` (RICE scoring), `domain-observability/src/logger.ts`

**`tests/`:**
- Purpose: Playwright test suite (separate workspace package)
- Contains: 48 e2e specs, 2 governance specs, 1 unit spec
- Key files: `playwright.config.ts`, `e2e/_helpers.ts`

## Key File Locations

**Entry Points:**
- `apps/web/scripts/serve.mjs`: Production HTTP server
- `apps/web/astro.config.mjs`: Astro configuration
- `apps/web/src/middleware.ts`: Request pipeline

**Configuration:**
- `meitheal-hub/config.yaml`: Add-on manifest (version, arch, capabilities)
- `apps/web/tsconfig.json`: TypeScript config with path aliases
- `pnpm-workspace.yaml`: Monorepo workspace definition

**Core Logic:**
- `apps/web/src/domains/tasks/persistence/task-repository.ts`: All task queries
- `apps/web/src/domains/ha/ha-startup.ts`: HA integration bootstrap
- `apps/web/src/lib/task-modal-controller.ts`: Task detail modal behavior

**Layout & Styling:**
- `apps/web/src/layouts/Layout.astro`: Main layout (1,255 LoC) — includes task modal, search hub launcher, nav
- `apps/web/src/styles/global.css`: CSS entry point importing all partials

## Naming Conventions

**Files:**
- kebab-case for all source files: `task-modal-controller.ts`, `ha-startup.ts`
- PascalCase for Astro components: `FilterToolbar.astro`, `StatusBadge.astro`
- UPPERCASE for GSD/planning docs: `STACK.md`, `ARCHITECTURE.md`
- Underscore prefix for CSS partials: `_kanban.css`, `_tokens.css`

**Directories:**
- kebab-case: `domain-tasks/`, `integration-core/`, `vikunja-compat/`
- Short noun for domains: `ha/`, `ai/`, `todo/`, `offline/`

## Where to Add New Code

**New Page:**
- Page: `apps/web/src/pages/{name}.astro`
- Controller: `apps/web/src/lib/{name}-controller.ts`
- CSS: `apps/web/src/styles/_{name}.css` (import in `global.css`)

**New Domain Module:**
- Create: `apps/web/src/domains/{name}/`
- Add `index.ts` barrel export
- API routes: `apps/web/src/pages/api/{name}/`

**New Shared Component:**
- UI: `apps/web/src/components/ui/{Name}.astro`
- Layout: `apps/web/src/components/layout/{Name}.astro`

**New Domain Package (pure logic):**
- Create: `packages/domain-{name}/`
- Add `package.json` with `@meitheal/domain-{name}` name
- Export from `src/index.ts`
- Reference in `pnpm-workspace.yaml`

**New Test:**
- E2E: `tests/e2e/{feature}.spec.ts`
- Unit: `tests/unit/{module}.spec.ts`

**New Utility:**
- Shared helpers: `apps/web/src/lib/{utility-name}.ts`

## Special Directories

**`.astro/`:**
- Purpose: Astro build/collection cache
- Generated: Yes
- Committed: No (gitignored)

**`dist/`:**
- Purpose: Production build output
- Generated: Yes (by `astro build`)
- Committed: No

**`.data/`:**
- Purpose: Runtime SQLite database files
- Generated: Yes (at runtime)
- Committed: No

**`meitheal-hub/`:**
- Purpose: HA add-on packaging (Dockerfile, run.sh, config.yaml)
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-03-16*
