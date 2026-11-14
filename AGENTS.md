# AGENTS

> Repository requirements for working on Meitheal. See [Contributing](CONTRIBUTING.md) for setup and review.

## Project Identity

Meitheal helps people keep track of household tasks and routines in Home Assistant. It stores task data locally. The app connects tasks to calendars, to-do lists, and automations that users set up.

The Home Assistant add-on runs an Astro server and uses Node.js built-in SQLite (`node:sqlite` `DatabaseSync`) repositories. Keep the app and its optional integration distinct. See the [README](README.md) for the product overview and the [automation guide](docs/kcs/agent-automation-guide.md) for use by tools and agents.

## Hard Requirements

- Preserve **Astro-first** architecture decisions
- Prefer official/open Astro integrations before custom implementations
- Maintain strict **DDD bounded contexts** and ubiquitous language
- Maintain **KCS artifacts** in the same change set as code behavior updates
- Keep **Home Assistant add-on compatibility** as a first-class constraint
- Keep HA publishing compatibility aligned with <https://developers.home-assistant.io/docs/apps/publishing>
- Maintain `repository.yaml` and add-on `config.yaml` `image` contract (`...-{arch}`) for publish readiness

## Automation Review

- Review each automated pull request finding. Fix it or record why it does not apply.

## Architecture

**DDD monorepo** with Astro SSR + domain packages + event-driven integration.

| Layer | Location | Purpose |
|-------|----------|---------|
| Web Runtime | `apps/web/` | Astro SSR app — pages, API routes, middleware |
| Domain Packages | `packages/domain-*/` | Pure domain logic — `auth`, `tasks`, `strategy`, `observability` |
| In-App Domains | `apps/web/src/domains/` | Domain modules such as `agents/`, `auth/`, `ha/`, `pillars/`, `todo/`, `tasks/`, and `search/` |
| Integration Core | `packages/integration-core/` | Calendar adapter interface + HA implementation |
| API Layer | `apps/web/src/pages/api/` | Native routes |
| Middleware | `apps/web/src/middleware.ts` | Ingress rewriting, CSP, CSRF, rate limiting |
| Ingress Wrapper | `apps/web/scripts/serve.mjs` | HTTP server normalizing `//` → `/` for HA |

## DDD Context Boundaries

| Context | Path | Responsibility |
|---------|------|---------------|
| `domain-auth` | `packages/domain-auth/` | Ingress detection, CSRF, session policy, **license key verification** |
| `domain-tasks` | `packages/domain-tasks/` | Task CRUD, persistence, sync, domain events |
| `domain-strategy` | `packages/domain-strategy/` | RICE scoring, strategic lenses |
| `domain-observability` | `packages/domain-observability/` | Structured logging, audit trail |
| `integration-core` | `packages/integration-core/` | Calendar/todo adapters, HA bridge |
| `domains/agents/` | `apps/web/src/domains/agents/` | MCP, WebMCP, and A2A protocol contracts, schema expansion, and availability gates (`@domains/agents` on server; `@domains/agents/webmcp-protocol` for pure browser contracts) |
| `domains/ha/` | `apps/web/src/domains/ha/` | HA events, WebSocket, connection status |
| `domains/search/` | `apps/web/src/domains/search/` | Universal search orchestration and catalog shaping |
| `domains/todo/` | `apps/web/src/domains/todo/` | HA todo list sync, status mapping |
| `domains/pillars/` | `apps/web/src/domains/pillars/` | Pillar CRUD, Principles/Non-Negotiables, associations, inheritance |

Cross-context imports must use public package APIs (`@domains/*`), not deep internal paths. Browser scripts import `@domains/agents/webmcp-protocol` so SQLite modules never enter client bundles.

## Dual-Repo Architecture

The source repository contains the application, tests, and CI. The [public add-on repository](https://github.com/ryan-winkler/meitheal-ha-addon) contains the Store manifests, setup guides, and support issues.

- Keeping `meitheal-ha-addon` manifest-only ensures Home Assistant Supervisor clones and refreshes quickly (~2 MB) on low-power devices without pulling monorepo history and tests.
- The release workflow verifies both image digests before stable promotion.
- Stable promotion uses `ADDON_REPO_TOKEN` scoped to the add-on repository.
- A separate reviewed change promotes Canary discovery after hardware and rollback checks.
- Use [Support](SUPPORT.md) for the public and source reporting paths.

## License Key System

Offline JWT license validation using Ed25519 — no phone-home, homelab-friendly.

| Component | Location |
|-----------|----------|
| Key generation | `scripts/generate-license.mjs` |
| Verification | `packages/domain-auth/src/index.ts` → `verifyLicenseKey()` |
| Public key | Embedded in `domain-auth` as `LICENSE_PUBLIC_KEY_PEM` |
| Private key | `.keys/meitheal-license.pem` (ignored by Git, keep an encrypted backup) |
| Config | `license_key: str?` in both `config.yaml` files |
| API | `GET /api/license/status` |
| Tests | `tests/e2e/license-key.spec.ts` (11 tests) |

- **Grace mode**: app runs fully without a key. No features gated until enforcement is added.
- Plans: `personal`, `household`, `commercial` — type `LicensePlan` in domain-auth
- **⚠️ CRITICAL**: losing `.keys/meitheal-license.pem` means ALL existing keys become unverifiable

## Ingress Patterns (Critical)

- `serve.mjs` normalizes `//` paths before Astro routing (prevents 301 redirect loops)
- `ingress-policy.ts` determines ingress context from `X-Ingress-Path` header
- `Layout.astro` monkey-patches `fetch()` to prefix API calls with ingress path
- `middleware.ts` rewrites HTML attributes (`href`, `src`) with ingress prefix
- ClientRouter/view transitions are **disabled** behind ingress to prevent redirect loops
- All client-side fetch calls must work behind HA ingress (global fetch wrapper in `Layout.astro`)
- **Never** issue server-side redirects to bare `/` paths — they escape the ingress iframe

### ⚠️ Gotchas

- **Do NOT wrap client-side `fetch()` with `apiUrl()`** — `Layout.astro` already monkey-patches `window.fetch` to auto-prefix. Using `apiUrl()` double-prefixes the path
- **`getHAConnectionStatus()` is passive** — it only reads in-memory state. Call `await getHAConnection()` first to ensure WebSocket is established
- **Vite HMR listener accumulation** — HMR re-evaluates `<script>` blocks without aborting the previous Astro lifecycle signal. When adding `addEventListener` on long-lived DOM elements (forms, overlays), either: (1) use `element.cloneNode(true)` + `replaceWith()` to strip old listeners before registering, or (2) use a window-scoped guard flag. Module-scoped guards do NOT survive HMR since each re-eval creates a new scope.
- **Task API POST response is FLAT** — `POST /api/tasks` returns `{ id, ticket_key, title, ... }`, NOT `{ task: { id, ... } }`. Wrapping access like `res.task?.id` will silently fail.
- **Custom fields may contain non-primitives** — Shopping items store `items: [{name, qty, category}]` in `custom_fields`. Always filter with `typeof v !== "object"` before rendering with `String()`, or display `[object Object]`.
- **Always pass `AbortSignal` to `addEventListener`** — Astro `pageLifecycle.onPageLoad(signal)` provides the signal. Listeners without `{ signal }` accumulate across navigations (memory leak).

## Settings Shell Patterns (Critical)

- `apps/web/src/lib/settings-registry.ts` is the canonical source for settings section ids, labels, and settings-search metadata
- Keep Settings navigation hash-based (`#look-and-feel-settings`, `#app-pwa-settings`, `#backups-reset-settings`, etc.; legacy hashes like `#personal-settings` resolve via `LEGACY_SETTINGS_SECTION_ALIASES`) so the page stays ingress-safe inside HA and PWA scopes
- Bootstrap Settings via `apps/web/src/lib/settings-page.ts` and `pageLifecycle`; do not add long-lived component-owned `astro:page-load` listeners back into settings panels
- `apps/web/src/lib/settings-store.ts` preserves the flat `/api/settings` contract; do not change persisted setting keys in UI refactors
- Companion handoff links live in `apps/web/src/lib/settings-shell-controller.ts` / `apps/web/src/components/settings/SettingsAppPwa.astro` and must preserve ingress-scoped paths

## Search Patterns

- Use the shared `apps/web/src/components/layout/SearchHub.astro` + `apps/web/src/lib/search-hub-controller.ts` path for launcher/UI behavior
- Extend `apps/web/src/domains/search/` and `/api/search` instead of adding page-local search endpoints or duplicate result registries
- Settings results in search should come from `settings-registry.ts`, not from a second settings-specific search source

## Coding Conventions

| Category | Convention | Example |
|----------|-----------|---------|
| Files | kebab-case | `task-sync-service.ts` |
| Functions | camelCase | `createTask()`, `resolveIntegrationOutcome()` |
| Types/Interfaces | PascalCase | `TaskAggregate`, `CalendarSyncState` |
| Test specs | `<name>.spec.ts` | `ha-calendar-adapter.spec.ts` |

- No semicolons, double quotes, 2-space indent
- Named exports only — no default exports
- Import order: Node builtins → Framework → External → Workspace → Relative
- Path alias: `@domains/` → `apps/web/src/domains/`
- Discriminated unions for API results: `{ ok: true } | { ok: false, errorCode }`

## Testing

| Command | What |
|---------|------|
| `pnpm --filter @meitheal/tests test:ci` | Full suite with a fresh server per spec. Build the web app first. |
| `pnpm --filter @meitheal/tests test <file>` | Specific spec |
| `pnpm check` | Typecheck all packages |

- Tests import domain logic directly from workspace packages
- HA tests use local HTTP server harness to simulate HA API
- Persistence tests use temp SQLite (`file:${tmpdir}/...`)
- No shared state between specs — no external mocking framework

## Logging

- Single JSON object per line to stdout (Loki-compatible)
- Schema: `{ ts, level, event, domain, component, request_id, message, metadata }`
- Redact secrets by default via `defaultRedactionPatterns`
- Do not introduce high-cardinality Loki labels (user IDs, task IDs, URLs)
- `ActorType` includes: `human`, `bot`, `system`, `webhook`, `calendar_sync`, `llm`, `n8n`, `nodered`, `agent`
- `trace_id` and `span_id` fields on `LogEvent` enable Grafana Alloy OTel trace correlation

## API and Automation Contracts

Build-time generators produce zero-drift documentation served as static files.

| Artifact | Generator | Output |
|----------|-----------|--------|
| OpenAPI 3.1 spec | `apps/web/scripts/generate-openapi.mjs` | `public/openapi.yaml` |
| Precompiled MCP catalog | `apps/web/scripts/generate-mcp-tools.mjs` | `src/generated/mcp-tools.json` |
| Typed Tabler icon registry | `apps/web/scripts/generate-icons.mjs` | `src/generated/icon-registry.ts` |
| AsyncAPI 2.6 spec | `apps/web/scripts/generate-asyncapi.mjs` | `public/asyncapi.yaml` |

- `prebuild` runs `generate:codegen` (`generate:openapi` -> `generate:mcp` -> `generate:icons`) -> `generate:asyncapi` before `astro build`
- Adding a new API route? Add its entry to the `paths` object in `generate-openapi.mjs` and run `pnpm --filter @meitheal/web run generate:codegen`
- Adding a new domain concept? Add its schema to the `schemas` object in `generate-openapi.mjs`
- Adding a new SSE/webhook event? Add its channel to `generate-asyncapi.mjs`

### MCP Dynamic Tools

- Production `apps/web/src/pages/api/mcp.ts` loads the precompiled `src/generated/mcp-tools.json` catalog (with dynamic `openapi.yaml` fallback in dev/tests or when `MEITHEAL_MCP_DYNAMIC_OPENAPI=1`)
- OpenAPI operations become tools when the caller has the mapped API scope as well as `mcp:execute`
- Custom handlers in `customHandlers` Map override specific tools (e.g., `completeTask` and `searchTasks`)
- `EXCLUDED_OPS` set prevents internal endpoints from becoming tools
- Dev mode: 30s cache TTL. Production: infinite cache

### Agent Traceability Headers

Send these headers from external callers (n8n, Node-RED, AI agents):

| Header | Purpose | Validation |
|--------|---------|------------|
| `X-Automation-Source` | Caller identity | Allowlisted: `browser`, `webmcp`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron` |
| `X-Agent-Id` | Specific agent ID | Truncated to 128 chars, alphanumeric + underscores + dots + hyphens only |

Both are logged in structured API request logs (`metadata.automation_source`, `metadata.agent_id`).

## Git Commit Policy

- Commit under the contributor's Git identity with descriptive messages. Omit `Co-authored-by` trailers.
- **Branch Push Rule (Mandatory)**: Only automatically push to `dev` (the primary/default branch). Never automatically push to `main` (beta channel, mostly unused) or `release` (full production release); promote to `main` or `release` only when explicitly directed by the maintainer.
- A human maintainer squash-merges automated contributions. Do not push force-authored bot commits directly to `dev`, `main`, or `release`.
- Follow the review process in [Contributing](CONTRIBUTING.md).

## Deploy Rules

Use the single Canary App entry for feature work and validation. Its directory is `meitheal-hub-canary`, slug is `meitheal_canary`, and image family is `meitheal-canary-{arch}`. Settings and other feature changes belong to that same entry. Release commands enforce the canonical manifests in the source and destination repositories.

Meitheal uses a **three-branch, two-channel release strategy** (see `docs/kcs/releasing.md` for the full runbook):

| Branch | Role | Auto-Push Allowed | Version / Stage |
|--------|------|-------------------|-----------------|
| `dev` | Primary default branch (Canary) | **Yes** (automated pushes/PRs target here only) | Commit SHA / `0.0.2-canary` (`experimental`) |
| `main` | Beta channel (mostly unused) | **No** (explicit maintainer promotion only) | Staging / Beta |
| `release` | Full production release (`meitheal-hub/`) | **No** (explicit maintainer release promotion only) | Strict SemVer `0.0.{digit}` (`stable`) |

- **Canary (`dev`)**: Pushes to `dev` trigger `publish-canary-images.yml` (`build-only` multi-arch smoke checks). It must never automatically push to `main` or `release`.
- **Beta (`main`)**: Kept mostly unused; reserved for explicit maintainer beta promotion before full release.
- **Stable (`release`)**: Only explicit maintainer promotions to `release` or matching `v*` tags trigger `publish-addon-images.yml`. The system validates version sync across manifests and builds multi-arch release images.
- **SemVer Policy (Mandatory)**: Do not boost versions without explicit reason and maintainer approval. Keep versions on the `0.0.{one digit}` line (for example `0.0.1`) and increment strictly by `+0.0.1` via `node scripts/bump-version.mjs patch` unless explicitly told otherwise (`--force-semver`).
- **CI & Quality Gates**: Every PR runs `ci.yml` (governance, tests, Codecov coverage upload), `dependency-review.yml`, and CodeRabbit AI review across `dev`, `main`, and `release`. The OpenSSF Scorecard analyzes repository security on `dev` weekly.
- **Caching**: Docker builds use BuildKit cache mounts (`--mount=type=cache,id=pnpm-store`) and GitHub Actions cache (`type=gha`).

## Verification Tiers (Mandatory)

Changes **must** be verified in the correct environment tier before completion.

| Change touches… | Required Tier | How to start |
|-----------------|---------------|--------------|
| CSS, layout, UI components, client JS | 🔧 Tier 1: `npm run dev` in `apps/web/` | Local Astro dev server |
| Ingress, middleware, `serve.mjs` | 🏠 Tier 2: `./scripts/devcontainer-up.sh` | HA devcontainer |
| HA API, WebSocket, `domains/ha/` | 🏠 Tier 2 | HA devcontainer |
| Supervisor API, `run.sh`, `config.yaml` | 🏠 Tier 2 | HA devcontainer |
| Calendar/Todo sync, entity exposure | 🏠 Tier 2 | HA devcontainer |
| LLM API (`llm_api.py`, `__init__.py`) | 🏠 Tier 2 | HA devcontainer |
| Addon lifecycle (start/stop/build) | 🏠 Tier 2 | HA devcontainer |
| Final acceptance on real data | 🌐 Tier 3 | Approved Home Assistant hardware |

> **⚠️ AGENTS**: Do NOT mark HA integration work as verified using only Tier 1. The canonical Tier 2 path is opening the checked-in `.devcontainer/devcontainer.json` in a compatible editor and running `Start Home Assistant`. Use `./scripts/devcontainer-up.sh` for status, recovery, and logs around that environment. See the [Home Assistant devcontainer runbook](docs/kcs/home-assistant-devcontainer.md).

## KCS Rules

- New behavior requires updated docs and a runbook touchpoint
- ADRs capture architectural and legal/security decisions
- Error messages should support self-service debugging

## Licensing Boundaries

Use [LICENSE](LICENSE) for Meitheal-owned material and [NOTICE](NOTICE) for separately licensed material. The current release excludes the historical compatibility API and alternate runtime.

- Keep existing third-party notices and the separate license files in `integrations/`.
- Integration code in `integrations/` communicates with the core through network APIs.
- Keep the license and notices with future image builds. `LicenseRef-Meitheal-Source-Available-1.0` describes the Meitheal source grant. Distributed images must use `org.opencontainers.image.licenses=LicenseRef-Proprietary`; this binary metadata does not change source or integration grants.
- Keep contributor agreements in the repository’s signing workflow.
- Keep private signing keys outside Git.

## Required Files (CI Enforced)

- `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `SECURITY.md`, `COMMERCIAL.md`
- `WEBMCP.md` and the discovery files `public/.well-known/mcp.json` and `public/.well-known/jsondoc.json`
- `.coderabbit.yaml`, `repository.yaml`, and the stable App manifest and docs
- `docs/index.md`, the Home Assistant devcontainer and operations runbooks, and the architecture and licensing decisions
