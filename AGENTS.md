# AGENTS

> This file defines mandatory behavior for human and AI contributors working in Meitheal.
> Extends the shared rules in `~/.gemini/agents/agent-template.md`.

## Project Identity

Meitheal is a **task management and strategic planning hub** running as a **Home Assistant add-on** (HA Supervisor). Built with Astro SSR, Drizzle ORM (SQLite), and domain-driven design.

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
| In-App Domains | `apps/web/src/domains/` | `auth/`, `ha/`, `todo/`, `tasks/`, `integrations/`, `search/` |
| Integration Core | `packages/integration-core/` | Calendar adapter interface + HA implementation |
| API Layer | `apps/web/src/pages/api/` | Native + Vikunja v1 compat routes |
| Middleware | `apps/web/src/middleware.ts` | Ingress rewriting, CSP, CSRF, rate limiting |
| Ingress Wrapper | `apps/web/scripts/serve.mjs` | HTTP server normalizing `//` → `/` for HA |

## DDD Context Boundaries

| Context | Path | Responsibility |
|---------|------|---------------|
| `domain-auth` | `packages/domain-auth/` | Ingress detection, CSRF, session policy |
| `domain-tasks` | `packages/domain-tasks/` | Task CRUD, persistence, sync, domain events |
| `domain-strategy` | `packages/domain-strategy/` | RICE scoring, strategic lenses |
| `domain-observability` | `packages/domain-observability/` | Structured logging, audit trail |
| `integration-core` | `packages/integration-core/` | Calendar/todo adapters, HA bridge |
| `domains/ha/` | `apps/web/src/domains/ha/` | HA events, WebSocket, connection status |
| `domains/search/` | `apps/web/src/domains/search/` | Universal search orchestration and catalog shaping |
| `domains/todo/` | `apps/web/src/domains/todo/` | HA todo list sync, status mapping |

Cross-context imports must occur through public package APIs, not deep path imports.

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

## Git Commit Policy

**Commits must not be attributed to the Copilot bot identity.**

- Every commit message produced by an AI agent **must** end with a `Co-authored-by` trailer:
  ```
  Co-authored-by: ryan-winkler <ryan-winkler@users.noreply.github.com>
  ```
- PRs opened by an AI agent should be **squash-merged** by the human owner so the final commit lands under the human author's identity.
- Do not push force-authored bot commits directly to `main`.

## Deploy Rules

- Pushing to `main` does NOT deploy. Push a version tag (`v*`) to trigger CI Docker build
- Version in `config.yaml` must match the tag (e.g., `version: "0.2.6"` ↔ `v0.2.6`)
- Also bump `MEITHEAL_VERSION` in `run.sh` to match

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

Meitheal uses a dual-licensing strategy. Agents must respect these boundaries:

| Scope | License | Notes |
|-------|---------|-------|
| Root (`apps/`, `packages/`, `meitheal-hub/`) | AGPL-3.0 + Commercial | Dual-licensed; see `COMMERCIAL.md` |
| `integrations/home-assistant/` | Apache 2.0 | API client boundary — no AGPL contamination |
| `integrations/nodered/` | Apache 2.0 | API client boundary — no AGPL contamination |
| `apps/web/src/domains/integrations/vikunja-compat/` | AGPL-3.0 only | Third-party copyright — cannot be commercially relicensed |

**Rules:**
- All PRs require a signed CLA (enforced by `.github/workflows/cla.yml`)
- Do not move AGPL-only code (e.g. vikunja-compat) into directories covered by the commercial license
- Integration code in `integrations/` must only communicate with the core via network APIs (REST/WebSocket/MCP)
- When creating new integration directories, include an explicit `LICENSE` file

## Required Files (CI Enforced)

- `README.md`, `AGENTS.md`, `SKILL.md`, `WEBMCP.md`
- `COMMERCIAL.md`
- `.coderabbit.yaml`
- `.skills/core-workflows/SKILL.md`
- `.zeroclaw/soul.md`
- `docs/decisions/*.md`, `docs/kcs/*.md`
- `public/.well-known/mcp.json`, `public/.well-known/jsondoc.json`
