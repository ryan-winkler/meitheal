# Codebase Stack — Meitheal

> Last refreshed: 2026-03-19

## Runtime & Language

| Component | Version | Notes |
|-----------|---------|-------|
| Node.js | v22.22.1 | Runtime for SSR and build |
| TypeScript | ^5.9.3 | Strict mode, path aliases |
| pnpm | 10.8.0 | Workspaces monorepo manager |

## Framework

| Component | Version | Role |
|-----------|---------|------|
| Astro | ^6.0.4 | SSR framework — `output: "server"` with `@astrojs/node` adapter |
| Tailwind CSS | ^4.2.1 | Utility CSS via `@tailwindcss/vite` plugin (v4 — not `@astrojs/tailwind`) |

**Astro config:** `apps/web/astro.config.mjs`
- SSR server mode, `trailingSlash: "never"`, HTML compression, prefetch enabled
- Custom `fontsource-relative-paths` Vite plugin fixes font 404s in HA ingress
- Version injected from `meitheal-hub/config.yaml` at build time via `vite.define`

## Database

| Component | Version | Role |
|-----------|---------|------|
| SQLite | (via libsql) | Embedded database |
| `@libsql/client` | ^0.17.0 | SQLite client |
| `drizzle-orm` | ^0.45.1 | Type-safe ORM |
| `drizzle-kit` | ^0.31.9 | Migration tooling |

**Schema:** `apps/web/drizzle/schema.ts`
**Migrations:** `apps/web/drizzle/migrations/` (3 migrations: init, settings, todo_sync)
**Config:** `apps/web/drizzle.config.ts`

## Dependencies (Production)

| Package | Purpose |
|---------|---------|
| `date-fns` ^4.1.0 | Date manipulation |
| `date-fns-tz` ^3.2.0 | Timezone handling |
| `home-assistant-js-websocket` ^9.6.0 | HA WebSocket API client |
| `marked` ^17.0.4 | Markdown rendering |
| `sanitize-html` ^2.17.1 | HTML sanitization |
| `undici` ^7.24.3 | HTTP client (fetch) |
| `ws` ^8.19.0 | WebSocket server |
| `yaml` ^2.8.2 | YAML parsing (config.yaml) |
| `zod` ^4.3.6 | Schema validation |

## Fonts

| Package | Font |
|---------|------|
| `@fontsource-variable/geist` | UI body text |
| `@fontsource-variable/inter` | Headings |
| `@fontsource/jetbrains-mono` | Monospace code |
| `@fontsource/outfit` | Display/branding |

## Workspace Packages

| Package | Path | Lines | Purpose |
|---------|------|-------|---------|
| `@meitheal/domain-auth` | `packages/domain-auth/` | 37 | Ingress detection, CSRF |
| `@meitheal/domain-observability` | `packages/domain-observability/` | 222 | Structured JSON logging |
| `@meitheal/domain-strategy` | `packages/domain-strategy/` | 674 | RICE scoring, rule resolver |
| `@meitheal/domain-tasks` | `packages/domain-tasks/` | 716 | Domain model, handoff, tasks |
| `@meitheal/integration-core` | `packages/integration-core/` | 1855 | A2A, CalDAV, Grocy, HA calendar, webhooks |

## Build & Scripts

| Script | Command | Effect |
|--------|---------|--------|
| `dev` | `astro dev` | Local dev server |
| `build` / `check` | `astro build` | Production build + typecheck |
| `db:migrate` | `node scripts/migrate.mjs` | Run SQLite migrations |
| `schema:drift` | `node scripts/schema-drift-check.mjs` | Verify schema matches migrations |
| `perf:budget` | `node scripts/perf-budget-check.mjs` | Bundle size check |

## Deployment

- **Target:** Home Assistant add-on (HA Supervisor)
- **Add-on config:** `meitheal-hub/config.yaml`
- **Runtime wrapper:** `apps/web/scripts/serve.mjs` (70 lines — normalizes `//` paths)
- **CI:** Push `v*` tags triggers Docker build via `.github/workflows/`
- **Service worker:** `apps/web/public/sw.js`
