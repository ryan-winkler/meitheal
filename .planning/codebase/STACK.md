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

## Deployment & Release Channels

**Target:** Home Assistant add-on (HA Supervisor)

Meitheal uses a **two-channel release strategy** — both channels live in this repo as separate addon directories.

| Channel | Addon Dir | Image | Version | Trigger | Stage |
|---------|-----------|-------|---------|---------|-------|
| **Stable** | `meitheal-hub/` | `ghcr.io/coolock-village/meitheal-{arch}` | Semver (`0.0.1`) | vtag push (`v*`) | `stable` |
| **Canary** | `meitheal-hub-canary/` | `ghcr.io/coolock-village/meitheal-canary-{arch}` | Commit SHA | Push to `main` | `experimental` |

### Publishing a Stable Release (Step-by-Step)

1. **Bump version** — updates 4 files atomically:
   ```bash
   node scripts/bump-version.mjs patch   # 0.0.1 → 0.0.2
   # or: node scripts/bump-version.mjs minor  # 0.0.2 → 0.1.0
   # or: node scripts/bump-version.mjs 1.0.0  # explicit version
   ```
   Files updated: `meitheal-hub/config.yaml`, `meitheal-hub/run.sh`, `apps/web/package.json`, `apps/web/public/sw.js`

2. **Update CHANGELOG.md** with the new version entry

3. **Commit, tag, and push:**
   ```bash
   git add -A
   git commit -m "🔖 release v0.0.2"
   git tag v0.0.2
   git push origin main --tags
   ```

4. **CI publishes** — `publish-addon-images.yml` builds multi-arch images and pushes to GHCR

5. **Verify** — HA → Settings → Add-ons → Meitheal → Check for updates → Restart

### How Canary Auto-Publishes

Canary is **fully automated** — no manual steps required:

1. Code is pushed/merged to `main`
2. `publish-canary-images.yml` triggers (skips if push was from `github-actions[bot]`)
3. CI builds same `meitheal-hub/Dockerfile`, pushes as `meitheal-canary-{arch}:{sha}` + `:canary`
4. CI runs `scripts/update-canary-version.mjs` to update `meitheal-hub-canary/config.yaml` → commits back with `[skip ci]`
5. HA Supervisor sees new version on next repo refresh

> **⚠️ AGENTS:** Do NOT manually edit `meitheal-hub-canary/config.yaml` version — it is CI-managed.

### Version Management Scripts

| Script | Purpose | Used By |
|--------|---------|---------|
| `scripts/bump-version.mjs` | Atomic semver bump across 4 stable files | Developer (manual) |
| `scripts/update-canary-version.mjs` | Update canary config.yaml version | CI only |
| `scripts/check-version-sync.mjs` | Verify all 4 stable files match | CI |

### Key Files

| File | Role |
|------|------|
| `meitheal-hub/config.yaml` | Stable addon config (`stage: stable`) |
| `meitheal-hub-canary/config.yaml` | Canary addon config (`stage: experimental`, CI-managed version) |
| `meitheal-hub/Dockerfile` | Shared Dockerfile for both channels |
| `meitheal-hub/run.sh` | Addon entrypoint |
| `apps/web/scripts/serve.mjs` | Runtime wrapper (normalizes `//` paths) |
| `apps/web/public/sw.js` | Service worker (version-stamped cache) |
| `.github/workflows/publish-addon-images.yml` | Stable CI (vtag trigger) |
| `.github/workflows/publish-canary-images.yml` | Canary CI (main push trigger) |
| `docs/kcs/releasing.md` | Full release runbook |
