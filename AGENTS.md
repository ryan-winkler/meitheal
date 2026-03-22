# AGENTS

> This file defines mandatory behavior for human and AI contributors working in Meitheal.
> Extends the shared rules in `~/.gemini/agents/agent-template.md`.

## Project Identity

Meitheal is a **Home Assistant-native household and homelab execution hub** that turns capture, planning, follow-through, automation, and agent workflows into one local-first system. It runs as a **Home Assistant add-on** (HA Supervisor) and is built with Astro SSR, SQLite/Drizzle repositories, and domain-driven design.

Think of Meitheal as the coordination layer that sits between daily work, Home Assistant entities and automations, companion flows, voice assistants, and AI agents. It is intentionally not a generic corporate project-management clone.

## Hard Requirements

- Preserve **Astro-first** architecture decisions
- Prefer official/open Astro integrations before custom implementations
- Maintain strict **DDD bounded contexts** and ubiquitous language
- Maintain **KCS artifacts** in the same change set as code behavior updates
- Keep **Home Assistant add-on compatibility** as a first-class constraint
- Keep HA publishing compatibility aligned with <https://developers.home-assistant.io/docs/apps/publishing>
- Maintain `repository.yaml` and add-on `config.yaml` `image` contract (`...-{arch}`) for publish readiness

## Automation Review

- CodeRabbitAI is enabled for PR review on this repository
- Treat CodeRabbit findings as required triage items (accept, fix, or explicitly document reject rationale)

## Architecture

**DDD monorepo** with Astro SSR + domain packages + event-driven integration.

| Layer | Location | Purpose |
|-------|----------|---------|
| Web Runtime | `apps/web/` | Astro SSR app — pages, API routes, middleware |
| Domain Packages | `packages/domain-*/` | Pure domain logic — `auth`, `tasks`, `strategy`, `observability` |
| In-App Domains | `apps/web/src/domains/` | `auth/`, `ha/`, `pillars/`, `todo/`, `tasks/`, `integrations/`, `search/` |
| Integration Core | `packages/integration-core/` | Calendar adapter interface + HA implementation |
| API Layer | `apps/web/src/pages/api/` | Native + Vikunja v1 compat routes |
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
| `domains/ha/` | `apps/web/src/domains/ha/` | HA events, WebSocket, connection status |
| `domains/search/` | `apps/web/src/domains/search/` | Universal search orchestration and catalog shaping |
| `domains/todo/` | `apps/web/src/domains/todo/` | HA todo list sync, status mapping |
| `domains/pillars/` | `apps/web/src/domains/pillars/` | Pillar CRUD, Principles/Non-Negotiables, associations, inheritance |

Cross-context imports must occur through public package APIs, not deep path imports.

## Dual-Repo Architecture

Source code is private. A public repo hosts HA add-on discovery manifests.

| Repo | Visibility | Purpose |
|------|-----------|---------|
| `Coolock-Village/meitheal` | **Private** | Source code, CI, tests, domain packages |
| `Coolock-Village/meitheal-ha-addon` | **Public** | Add-on manifests, docs, icons, LICENSE, COMMERCIAL.md |

- `sync-addon-repo.yml` copies manifests/docs/icons/translations from private → public on relevant pushes
- Requires `ADDON_REPO_TOKEN` secret (fine-grained PAT scoped to `meitheal-ha-addon`)
- HA users add `https://github.com/Coolock-Village/meitheal-ha-addon` as their repository URL
- Community: [org-level Discussions](https://github.com/orgs/Coolock-Village/discussions)
- Bug reports: [meitheal-ha-addon Issues](https://github.com/Coolock-Village/meitheal-ha-addon/issues)

## License Key System

Offline JWT license validation using Ed25519 — no phone-home, homelab-friendly.

| Component | Location |
|-----------|----------|
| Key generation | `scripts/generate-license.mjs` |
| Verification | `packages/domain-auth/src/index.ts` → `verifyLicenseKey()` |
| Public key | Embedded in `domain-auth` as `LICENSE_PUBLIC_KEY_PEM` |
| Private key | `.keys/meitheal-license.pem` (**gitignored**, back up to gopass) |
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
- Keep Settings navigation hash-based (`#personal-settings`, `#app-pwa-settings`, etc.) so the page stays ingress-safe inside HA and PWA scopes
- Bootstrap Settings via `apps/web/src/lib/settings-page.ts` and `pageLifecycle`; do not add long-lived component-owned `astro:page-load` listeners back into settings panels
- `apps/web/src/lib/settings-store.ts` preserves the flat `/api/settings` contract; do not change persisted setting keys in UI refactors
- Companion handoff links live in `apps/web/src/lib/settings-shell-controller.ts` / `apps/web/src/components/settings/SettingsSystem.astro` and must preserve ingress-scoped paths

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
| `pnpm --filter @meitheal/tests test` | All tests |
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

## Agent & Automation Infrastructure

Build-time generators produce zero-drift documentation served as static files.

| Artifact | Generator | Output |
|----------|-----------|--------|
| OpenAPI 3.1 spec | `apps/web/scripts/generate-openapi.mjs` | `public/openapi.yaml` |
| AsyncAPI 2.6 spec | `apps/web/scripts/generate-asyncapi.mjs` | `public/asyncapi.yaml` |
| LLM context (router) | `apps/web/scripts/generate-llms.mjs` | `public/llms.txt` |
| LLM context (full) | `apps/web/scripts/generate-llms.mjs` | `public/llms-full.txt` |
| AI plugin manifest | Static file | `public/.well-known/ai-plugin.json` |

- `prebuild` runs `generate:openapi` → `generate:llms` → `generate:asyncapi` before `astro build`
- Adding a new API route? Add its entry to the `paths` object in `generate-openapi.mjs`
- Adding a new domain concept? Add its schema to the `schemas` object in `generate-openapi.mjs`
- Adding a new SSE/webhook event? Add its channel to `generate-asyncapi.mjs`

### MCP Dynamic Tools

- `apps/web/src/pages/api/mcp.ts` reads `openapi.yaml` at startup, caches tool list
- Tools are auto-generated from `operationId` → tool name, parameters → input schema
- Custom handlers in `customHandlers` Map override specific tools (e.g., `completeTask`, `searchTasks`, `dailyBriefing`)
- `EXCLUDED_OPS` set prevents internal endpoints from becoming tools
- Dev mode: 30s cache TTL. Production: infinite cache

### Agent Traceability Headers

External callers (n8n, Node-RED, AI agents) should send:

| Header | Purpose | Validation |
|--------|---------|------------|
| `X-Automation-Source` | Caller identity | Allowlisted: `browser`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron` |
| `X-Agent-Id` | Specific agent ID | Truncated to 128 chars, alphanumeric + dots + hyphens only |

Both are logged in structured API request logs (`metadata.automation_source`, `metadata.agent_id`).

## Git Commit Policy

**Commits must not be attributed to the Copilot bot identity.**

- Every commit message produced by an AI agent **must** end with a `Co-authored-by` trailer:
  ```
  Co-authored-by: ryan-winkler <ryan-winkler@users.noreply.github.com>
  ```
- PRs opened by an AI agent should be **squash-merged** by the human owner so the final commit lands under the human author's identity.
- Do not push force-authored bot commits directly to `main`.

## Deploy Rules

Meitheal uses a **two-channel release strategy** (see `docs/kcs/releasing.md` for the full runbook):

| Channel | Dir | Trigger | Version | Stage |
|---------|-----|---------|---------|-------|
| Stable | `meitheal-hub/` | vtag push (`v*`) | Semver (`0.0.1`) | `stable` |
| Canary | `meitheal-hub-canary/` | Push to `main` | Commit SHA | `experimental` |

- **Stable**: Push a version tag (`v*`) to trigger CI Docker build. Version in `config.yaml` must match the tag (e.g. `version: "0.0.1"` ↔ `v0.0.1`). Also bump `MEITHEAL_VERSION` in `run.sh` to match. Use `node scripts/bump-version.mjs patch` for atomic bumps.
- **Canary**: Auto-publishes on every push to `main`. Do NOT manually edit `meitheal-hub-canary/config.yaml` version — it is CI-managed by `scripts/update-canary-version.mjs`.
- Unless explicitly requested, keep version bumps within the current release line and prefer the next patch release
- Do not move to a new version line such as `0.0.x` → `0.1.x` without explicit user direction

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
| Final acceptance on real data | 🌐 Tier 3 | Production HA (`ha.internal`) |

> **⚠️ AGENTS**: Do NOT mark HA integration work as verified using only Tier 1. The canonical Tier 2 path is reopening the checked-in `.devcontainer/devcontainer.json` in Antigravity or VS Code and running `Start Home Assistant`. Use `./scripts/devcontainer-up.sh` for status, recovery, and logs around that environment. See `.agents/workflows/devcontainer.md` for details.

## KCS Rules

- New behavior requires updated docs and a runbook touchpoint
- ADRs capture architectural and legal/security decisions
- Error messages should support self-service debugging

## Licensing Boundaries

Meitheal uses a **dual-licensing + proprietary distribution** strategy:

| Scope | License | Notes |
|-------|---------|-------|
| Source code (`apps/`, `packages/`, `meitheal-hub/`) | AGPL-3.0 + Commercial | Dual-licensed; see `COMMERCIAL.md` |
| Distributed binaries (Docker images) | Proprietary | Free for personal/homelab; see public repo LICENSE |
| `integrations/home-assistant/` | Apache 2.0 | API client boundary — no AGPL contamination |
| `integrations/nodered/` | Apache 2.0 | API client boundary — no AGPL contamination |
| `apps/web/src/domains/integrations/vikunja-compat/` | AGPL-3.0 only | Third-party copyright — cannot be commercially relicensed |

**Rules:**

- All PRs require a signed CLA (enforced by `.github/workflows/cla.yml`)
- Do not move AGPL-only code (e.g. vikunja-compat) into directories covered by the commercial license
- Integration code in `integrations/` must only communicate with the core via network APIs (REST/WebSocket/MCP)
- When creating new integration directories, include an explicit `LICENSE` file
- Docker image OCI labels must use `LicenseRef-Proprietary` (not MIT or AGPL)
- The `.keys/` directory is gitignored — never commit private signing keys

## Required Files (CI Enforced)

- `README.md`, `AGENTS.md`, `SKILL.md`, `WEBMCP.md`
- `COMMERCIAL.md`
- `.coderabbit.yaml`
- `.skills/core-workflows/SKILL.md`
- `.zeroclaw/soul.md`
- `docs/decisions/*.md`, `docs/kcs/*.md`
- `public/.well-known/mcp.json`, `public/.well-known/jsondoc.json`
