# Structure — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Root Layout

```
meitheal/
├── .agents/                    # AI agent rules and workflows
│   ├── rules/                  # Behavioral rules (autonomous, design-ux, etc.)
│   └── workflows/              # GSD workflows, devcontainer, local-dev, licensing
├── .devcontainer/              # HA devcontainer for Tier 2 testing
├── .github/                    # CI/CD workflows, CLA config
├── .planning/                  # GSD planning artifacts
│   ├── codebase/               # THIS — codebase map documents
│   ├── phases/                 # Phase context, research, plans
│   ├── persona-loops/          # Persona audit results
│   └── research/               # Domain research
├── .skills/                    # Skill definitions
├── .zeroclaw/                  # ZeroClaw soul definition
├── apps/
│   └── web/                    # Astro SSR application
├── docs/
│   ├── decisions/              # ADRs (adr-001 through adr-017+)
│   └── kcs/                    # KCS runbooks (releasing, etc.)
├── integrations/
│   └── home-assistant/         # Python HA custom integration (Apache 2.0)
├── meitheal-hub/               # Stable HA add-on manifests + Dockerfile
├── meitheal-hub-canary/        # Canary HA add-on manifests + Dockerfile
├── packages/
│   ├── domain-auth/            # Auth domain package
│   ├── domain-observability/   # Logging domain package
│   ├── domain-strategy/        # Strategy domain package
│   ├── domain-tasks/           # Tasks domain package
│   └── integration-core/       # Integration adapters package
├── public/                     # Static assets, .well-known, icons
├── scripts/                    # Build/deploy scripts
│   ├── bump-version.mjs        # Atomic version bumping
│   ├── generate-license.mjs    # License key generation
│   ├── update-canary-version.mjs # CI canary version management
│   └── devcontainer-up.sh      # HA devcontainer lifecycle
├── tests/
│   ├── e2e/                    # 75+ E2E test specs
│   ├── governance/             # Standards compliance tests
│   └── unit/                   # Unit tests
├── AGENTS.md                   # Mandatory AI contributor rules
├── CHANGELOG.md                # Release changelog
├── COMMERCIAL.md               # Commercial licensing terms
├── package.json                # Root monorepo config (v0.1.80)
├── pnpm-workspace.yaml         # Workspace: apps/*, packages/*, tests
└── repository.yaml             # HA repository discovery
```

## Astro App Layout

```
apps/web/
├── astro.config.mjs            # Astro config (server, Tailwind v4, version injection)
├── package.json                # @meitheal/web — deps, scripts
├── scripts/
│   ├── serve.mjs               # HTTP wrapper for HA ingress (// normalization)
│   ├── migrate.mjs             # DB migration runner
│   ├── schema-drift-check.mjs  # Schema drift detection
│   └── perf-budget-check.mjs   # Performance budget validation
└── src/
    ├── components/             # Astro components by domain
    │   ├── layout/             # Shell, nav, sidebar, search, section cards
    │   ├── tasks/              # Task CRUD components
    │   ├── pillars/            # Pillar cards, modals, selectors
    │   ├── views/              # View-specific wrappers (kanban, table, timeline)
    │   ├── settings/           # All settings panels
    │   ├── ui/                 # Reusable UI primitives
    │   ├── shared/             # Cross-domain shared components
    │   ├── gamification/       # XP, achievements, streaks
    │   ├── ha/                 # HA status indicators
    │   ├── pomodoro/           # Timer widget
    │   └── pwa/                # PWA install, offline
    ├── content/                # Astro content collections
    ├── domains/                # In-app bounded contexts (18 domains)
    ├── i18n/                   # en.json, ga.json, translations.ts
    ├── layouts/
    │   └── Layout.astro        # Root layout — head, body, nav, search, scripts
    ├── lib/                    # 90+ controllers, utilities, registries
    │   └── controllers/        # Additional controller subdirectory
    ├── pages/                  # Astro pages + API routes
    │   ├── api/                # 95+ REST API endpoints
    │   ├── areas/              # Area detail pages
    │   ├── goals/              # Goal listing
    │   ├── pillars/            # Pillar listing + detail
    │   └── projects/           # Project listing + detail
    ├── pwa/                    # PWA service worker
    ├── styles/                 # 23 CSS modules imported by global.css
    └── types/                  # TypeScript type definitions
```

## Key File Locations

### Entry Points
| File | Purpose |
|------|---------|
| `apps/web/src/pages/index.astro` | Dashboard / home page |
| `apps/web/src/layouts/Layout.astro` | Root layout (all pages) |
| `apps/web/src/middleware.ts` | Request pipeline (322 lines) |
| `apps/web/scripts/serve.mjs` | HTTP server wrapper (70 lines) |

### Pillars Domain (Phase 19 Focus)
| File | Purpose |
|------|---------|
| `apps/web/src/domains/pillars/pillar-service.ts` | Pillar CRUD + schema |
| `apps/web/src/domains/pillars/principle-service.ts` | Principle CRUD |
| `apps/web/src/domains/pillars/pillar-association-service.ts` | Entity associations |
| `apps/web/src/components/pillars/PillarCard.astro` | Pillar display card |
| `apps/web/src/components/pillars/PillarFormModal.astro` | Create/edit modal |
| `apps/web/src/pages/pillars/index.astro` | Pillars listing page |
| `apps/web/src/pages/pillars/[id].astro` | Pillar detail page |

### Naming Conventions
| Type | Convention | Example |
|------|-----------|---------|
| Files | kebab-case | `pillar-service.ts` |
| Functions | camelCase | `getPillarBySlug()` |
| Types/Interfaces | PascalCase | `Pillar`, `Principle` |
| CSS modules | `_kebab.css` | `_parent-page.css` |
| Test specs | `name.spec.ts` | `pillars.spec.ts` |
| Controllers | `*-controller.ts` | `habits-controller.ts` |
| Registries | `*-registry.ts` | `settings-registry.ts` |
