---
type: "Reference"
title: "Architecture overview"
description: "The components of Meitheal, how they connect, and where each responsibility lives in the repository."
---

# Architecture overview

Meitheal is one server-rendered web application that runs as a Home Assistant App, plus an optional custom integration that runs inside Home Assistant Core. This page describes the current release. [ADR 0002](decisions/0002-target-architecture.md) records the original target architecture, and later [decision records](decisions/index.md) refine it.

## Components

```text
 Browser / Companion app
        │  HTTPS through Home Assistant
        ▼
 Home Assistant Supervisor Ingress ─────────────┐
        │  authenticated user headers           │
        ▼                                       │
 Meitheal App container (meitheal-hub)          │
 ┌────────────────────────────────────────┐     │
 │ Astro SSR server (apps/web, Node.js)    │     │
 │  middleware: access, rate limits,       │     │
 │  security headers, logging              │     │
 │  pages + /api routes                    │     │
 │  domain services (apps/web/src/domains) │     │
 │  shared packages (packages/*)           │     │
 │  SQLite database on /data               │     │
 └────────────────────────────────────────┘     │
        │ Supervisor and Core APIs              │
        ▼                                       ▼
 Home Assistant Core ◄── Meitheal custom integration (integrations/home-assistant)
        │                 todo entity, sensors, services, Assist intents, LLM API
        ▼
 Calendars, automations, voice assistants

 Optional outbound integrations: webhooks, Grocy, n8n, Node-RED, Loki
 Optional agent access: MCP, WebMCP and A2A endpoints with scoped tokens
```

| Component | Location | Responsibility |
| --- | --- | --- |
| Web application | [apps/web](../apps/web) | Astro server output with the Node adapter. Renders every page, serves the JSON API under `/api`, the service worker, and the installable web app. |
| Request middleware | `apps/web/src/middleware.ts` | Resolves the Ingress context and agent tokens, enforces access, applies rate limits, CSRF checks and security headers, and writes request logs. |
| Application domains | `apps/web/src/domains` | Tasks, calendar, Home Assistant connection, agents, AI, labels, notifications, offline queue, pillars, search, and other features. Each domain owns its persistence code. |
| Domain packages | [packages](../packages) | `domain-auth` (agent tokens and scopes), `domain-tasks` (task rules), `domain-strategy` (prioritisation frameworks), `domain-observability` (structured, redacted logging), `integration-core` (webhooks, outbound fetch, integration contracts). They contain no web framework code. |
| Database | `apps/web/scripts/database-client.mjs`, `apps/web/drizzle` | SQLite through Node.js's built-in `node:sqlite` driver behind a libSQL-compatible client interface, with versioned migrations checked in CI. Stored at `/data/meitheal.db` in the App so Home Assistant backups include it. |
| Home Assistant App | [meitheal-hub](../meitheal-hub), [meitheal-hub-canary](../meitheal-hub-canary) | Dockerfile, AppArmor profile, startup scripts, and App manifests for the Stable and Canary channels. |
| Custom integration | [integrations/home-assistant](../integrations/home-assistant) | Python integration for Home Assistant Core: `todo.meitheal_tasks`, sensors, services, device triggers, Assist intents in English and Irish, MCP server, and a read-only LLM API. |
| Automation examples | [integrations/nodered](../integrations/nodered), `integrations/blueprints` | Node-RED flows and Home Assistant blueprints that call the API. |
| Tests | [tests](../tests) | Playwright end-to-end, unit and governance specs; pytest suites live with the integration. |

## Request flow

1. A person opens Meitheal from the Home Assistant sidebar. Home Assistant authenticates them and the Supervisor proxies the request through Ingress.
2. The middleware confirms the request came from the Supervisor, reads the validated user ID and admin flag, and applies rate limits on API and agent-discovery routes.
3. The page or API route calls a domain service, which reads or writes SQLite inside a transaction and records an activity or audit event.
4. Changes that other systems care about become events (for example `task.created`). Event handlers update configured Home Assistant sync targets and calendars and deliver signed webhooks, using idempotency keys so retries do not duplicate work; inside Home Assistant Core, the custom integration's `todo.meitheal_tasks` entity reads coordinator data polled from `/api/tasks`.
5. The response carries security headers and a request ID that also appears in the logs.

Automations and agents follow the same path without Ingress: they send an agent token, and the middleware checks its scope before the route runs.

## Data and state

- **Persistent:** the SQLite database on the App's `/data` volume.
- **Configuration:** App options from Home Assistant, plus settings stored in the database.
- **Browser:** appearance preferences and the offline task queue in the browser's storage. The service worker caches the app shell and clears sensitive caches on request.
- **Logs:** JSON lines to the App log, optionally shipped to Loki.

## Releases

For new Stable releases (after `0.0.1`), GitHub Actions builds the App image for `amd64` and `aarch64`, smoke-tests it against the Home Assistant base image, publishes it to the GitHub Container Registry with a signed build provenance attestation (verified with `gh attestation verify`), and updates the [App repository](https://github.com/ryan-winkler/meitheal-ha-addon) that Home Assistant reads. Stable `0.0.1` predates attestations and is verified by comparing the pulled image digest against the App repository commit. Canary images are smoke-tested as local builds in GitHub Actions and published from a qualified release host. The [release runbook](kcs/releasing.md) has the details.

## Related pages

- [Security assurance case](security-assurance-case.md)
- [Design system](../DESIGN.md)
- [Agent and MCP guide](../WEBMCP.md)
