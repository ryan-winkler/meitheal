# Stack — Meitheal

**Mapped:** 2026-03-21 | **Confidence:** HIGH

## Runtime & Language

| Component | Version | Notes |
|-----------|---------|-------|
| **Node.js** | ≥20 | Required by Astro 6 |
| **TypeScript** | 5.9.3 | Strict mode, no semicolons, double quotes |
| **Python** | 3.x | HA custom integration only (`integrations/home-assistant/`) |
| **pnpm** | 10.8.0 | Workspace manager, lockfile committed |

## Core Framework

| Library | Version | Purpose |
|---------|---------|---------|
| **Astro** | 6.0.4 | SSR app framework — `output: "server"` with `@astrojs/node` adapter |
| **Tailwind CSS** | 4.2.1 | Styling via `@tailwindcss/vite` plugin (v4, NOT `@astrojs/tailwind`) |
| **Drizzle ORM** | 0.45.1 | Schema-first ORM (used minimally — most SQL is raw via libsql) |
| **@libsql/client** | 0.17.0 | SQLite persistence — file-based `data.db` |
| **Zod** | 4.3.6 | Input validation |

## Key Dependencies

| Library | Version | Domain |
|---------|---------|--------|
| `date-fns` | 4.1.0 | Date formatting/manipulation |
| `date-fns-tz` | 3.2.0 | Timezone handling |
| `home-assistant-js-websocket` | 9.6.0 | HA WebSocket API client |
| `marked` | 17.0.4 | Markdown → HTML rendering |
| `sanitize-html` | 2.17.1 | HTML sanitization (server-side) |
| `ws` | 8.19.0 | WebSocket server support |
| `yaml` | 2.8.2 | YAML parsing (config files) |
| `undici` | 7.24.3 | HTTP client (fetch implementation) |

## Dev Dependencies

| Library | Version | Purpose |
|---------|---------|--------|
| `@astrojs/check` | 0.9.7 | Astro type checking |
| `drizzle-kit` | 0.31.9 | DB migration tooling |

## Workspace Packages

| Package | Path | Exports |
|---------|------|---------|
| `@meitheal/domain-auth` | `packages/domain-auth/` | Ingress detection, CSRF, license key verification |
| `@meitheal/domain-observability` | `packages/domain-observability/` | Structured JSON logging, redaction |
| `@meitheal/domain-strategy` | `packages/domain-strategy/` | RICE scoring, rule resolver, framework config |
| `@meitheal/domain-tasks` | `packages/domain-tasks/` | Task domain model, handoff state machine, vertical slice |
| `@meitheal/integration-core` | `packages/integration-core/` | Calendar adapters, webhook emitter, A2A handler, rate limiter |

## Build & Deploy

| Aspect | Detail |
|--------|--------|
| **Build** | `astro build` → server output via `@astrojs/node` standalone |
| **Serve** | `apps/web/scripts/serve.mjs` — custom HTTP wrapper normalizing `//` paths for HA ingress |
| **Docker** | Multi-arch (`amd64`, `aarch64`, `armhf`, `armv7`, `i386`) — builds via GitHub Actions |
| **Channels** | Stable (`meitheal-hub/`, semver tags) + Canary (`meitheal-hub-canary/`, commit SHA) |
| **Version** | `0.0.1` (app), `0.1.80` (monorepo) — sourced from `meitheal-hub/config.yaml` at build time |

## Fonts

| Font | Package | Usage |
|------|---------|-------|
| Inter (Variable) | `@fontsource-variable/inter` | Primary body text |
| Geist (Variable) | `@fontsource-variable/geist` | Headings / accent |
| JetBrains Mono | `@fontsource/jetbrains-mono` | Code / monospace |
| Outfit | `@fontsource/outfit` | UI elements |

## Configuration

| File | Purpose |
|------|---------|
| `apps/web/astro.config.mjs` | Astro config — server output, Tailwind v4 plugin, version injection, font path fix |
| `tsconfig.base.json` | Root TS config with path aliases |
| `pnpm-workspace.yaml` | Workspace definition: `apps/*`, `packages/*`, `tests` |
| `meitheal-hub/config.yaml` | HA add-on manifest (stable) |
| `meitheal-hub-canary/config.yaml` | HA add-on manifest (canary) |
| `repository.yaml` | HA repository discovery |

## Vite Custom Plugins

1. **`fontsource-relative-paths`** — Rewrites absolute `/_astro/font.woff2` to relative `./font.woff2` in CSS bundles for HA ingress compatibility
2. **Tailwind CSS v4** — Via `@tailwindcss/vite` (not the Astro integration)

## Defines

| Constant | Value | Purpose |
|----------|-------|---------|
| `__MEITHEAL_ASTRO_FIRST__` | `true` | Feature flag for Astro-first codepaths |
| `__MEITHEAL_VERSION__` | From `config.yaml` | Build-time version injection |

## Client-Side Utilities

| Module | Path | Purpose |
|--------|------|---------|
| `toast.ts` | `apps/web/src/lib/toast.ts` | Toast notification system — `showToast`, `showUndoToast`, `showRetryToast`, `showTaskCreatedToast` |
| `ticket-key.ts` | `apps/web/src/lib/ticket-key.ts` | `formatTicketKey(n)` → `MTH-XX` format |
| `page-lifecycle.ts` | `apps/web/src/lib/page-lifecycle.ts` | Astro page load lifecycle with `AbortSignal` for listener cleanup |
| `layout-controller.ts` | `apps/web/src/lib/layout-controller.ts` | Global event handling — listens for `meitheal:tasks-changed` and triggers page refresh |
| `kanban-controller.ts` | `apps/web/src/lib/kanban-controller.ts` | Kanban board interactivity — drag/drop, lanes, grouping |
| `task-modal-controller.ts` | `apps/web/src/lib/task-modal-controller.ts` | Task detail modal lifecycle |

## Key Client-Side Events

| Event | Dispatch Context | Handler |
|-------|-----------------|---------|
| `meitheal:tasks-changed` | After task CRUD operations | `layout-controller.ts` → `window.location.reload()` |
| `meitheal:task-detail` | Open task detail modal | `task-modal-controller.ts` |

