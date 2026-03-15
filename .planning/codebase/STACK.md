# Technology Stack

**Analysis Date:** 2026-03-15

## Languages

**Primary:**
- TypeScript 5.9.3 — All application logic, domain packages, API routes, tests
- CSS (Tailwind v4 + vanilla partials) — Styling via 18 partial files in `apps/web/src/styles/`

**Secondary:**
- JavaScript (ESM) — Build scripts (`scripts/*.mjs`), `serve.mjs` ingress wrapper
- Bash — `meitheal-hub/run.sh` addon lifecycle, `scripts/devcontainer-up.sh`
- Python — `meitheal-hub/llm_api.py` HA LLM API integration
- YAML — HA `config.yaml`, CI workflows, `repository.yaml`

## Runtime

**Environment:**
- Node.js 22 (specified in CI `setup-node`)
- pnpm 10.8.0 (`packageManager` field in root `package.json`)
- Lockfile: `pnpm-lock.yaml` (present)

**Production:**
- Docker (multi-arch: `aarch64`, `amd64`)
- HA Supervisor addon (ingress on port 3000)
- `serve.mjs` HTTP wrapper → Astro standalone

## Frameworks

**Core:**
- Astro 6.0.4 — SSR (`output: "server"`), `@astrojs/node` adapter (standalone mode)
- Tailwind CSS 4.2.1 — Via `@tailwindcss/vite` plugin (NOT `@astrojs/tailwind`)
- Drizzle ORM 0.45.1 — SQLite persistence (`@libsql/client` 0.17.0)
- Zod 4.3.6 — Schema validation

**Testing:**
- Playwright 1.58.2 — E2E + unit test runner (`@meitheal/tests` package)
- axe-core/playwright 4.11.1 — Accessibility testing

**Build/Dev:**
- Vite (bundled with Astro) — Dev server, HMR, custom plugins
- drizzle-kit 0.31.9 — Migration generation
- `@astrojs/check` 0.9.7 — Astro-specific type checking

## Key Dependencies

**Critical:**
- `home-assistant-js-websocket` 9.6.0 — HA WebSocket API client
- `date-fns` 4.1.0 + `date-fns-tz` 3.2.0 — Date handling
- `marked` 17.0.4 — Markdown rendering
- `sanitize-html` 2.17.1 — XSS prevention
- `ws` 8.19.0 — WebSocket client (server-side HA comms)
- `undici` 7.24.3 — HTTP client for Supervisor API

**Typography:**
- `@fontsource-variable/geist` 5.2.8 — Primary UI font
- `@fontsource-variable/inter` 5.2.8 — Alternate font
- `@fontsource/jetbrains-mono` 5.2.8 — Monospace / code
- `@fontsource/outfit` 5.2.8 — Display font

**Overrides (security):**
- `lodash` ≥4.17.23, `svgo` ≥4.0.1, `undici` ≥7.24.0, `devalue` ≥5.6.4, `esbuild` ≥0.25.0

## Configuration

**Astro (`apps/web/astro.config.mjs`):**
- `output: "server"` (full SSR)
- `trailingSlash: "never"`
- `compressHTML: true`, `prefetch: true`
- Custom Vite plugin: `fontsource-relative-paths` (fixes font URLs behind HA ingress)
- `vite.define`: `__MEITHEAL_ASTRO_FIRST__`, `__MEITHEAL_VERSION__`

**TypeScript (`apps/web/tsconfig.json`):**
- Extends `../../tsconfig.base.json`
- Path aliases: `@domains/*` → `src/domains/*`, `@lib/*` → `src/lib/*`, `@i18n/*` → `src/i18n/*`

**Version Management:**
- Single source of truth: `meitheal-hub/config.yaml` → `version` field
- `scripts/bump-version.mjs` — Atomic bump across config.yaml, run.sh, package.json
- `scripts/check-version-sync.mjs` — CI validation

## Platform Requirements

**Development:**
- Node 22, pnpm 10.8+
- SQLite (via libsql, file-based)
- Optional: HA devcontainer for Tier 2 testing

**Production:**
- Home Assistant Supervisor (add-on)
- Docker multi-arch (`ghcr.io/coolock-village/meitheal-{arch}`)
- Ingress enabled (port 3000, entry `/`)

---

*Stack analysis: 2026-03-15*
