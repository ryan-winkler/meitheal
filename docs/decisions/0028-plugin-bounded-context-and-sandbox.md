---
type: "Decision"
title: "ADR 0028: Sandboxed Plugin Bounded Context and Extension Contract"
description: "Defines the dedicated plugins bounded context, browser sandbox, server HTTP gateway, and permission model for Meitheal extensions and external connectors."
---

# ADR 0028: Sandboxed Plugin Bounded Context and Extension Contract

- **Date:** 2026-11-21
- **Status:** Accepted
- **Deciders:** Meitheal Maintainer

## Context

Households and contributors want to extend Meitheal with custom views, workflow helpers, and external issue trackers. Examples include GitHub Issues, Gitea Issues, Linear, and Nextcloud Deck.

Meitheal already provides core platform integrations under **Settings -> Connected Services** (`#connections-settings`). Those integrations manage Home Assistant, calendars, `todo.meitheal_tasks`, Grocy, n8n, and webhooks.

Meitheal runs as a multi-user Astro SSR web application behind Home Assistant Supervisor Ingress. Its runtime enforces a strict Content Security Policy (CSP) without `'unsafe-eval'` and protects administrator sessions. It also enforces strict client bundle budgets on low-memory devices such as Home Assistant Green.

An unsandboxed plugin model that evaluates JavaScript in the host window or loads same-origin iframes creates severe risks:

- A malicious plugin can read administrator cookies or call `/api/ha/*` routes backed by `SUPERVISOR_TOKEN`.
- A broken plugin can crash the main application shell or corrupt local SQLite data.
- Arbitrary server-side execution breaks Home Assistant AppArmor isolation and creates remote code execution risk.

Meitheal needs an extensible plugin architecture that preserves strict security, bounded contexts, Ingress compatibility, and low memory usage.

## Decision

### 1. Separate Bounded Context (`apps/web/src/domains/plugins/`)

Create a dedicated Domain-Driven Design (DDD) bounded context for plugins under `apps/web/src/domains/plugins/`.

- Keep **Connected Services** (`#connections-settings`) for core platform infrastructure: Home Assistant, calendars, to-do lists, Grocy, n8n, and webhooks.
- Manage modular extensions and third-party external connectors under **Plugins** (`#plugins-settings`).
- Support two plugin types through one manifest contract:
  - `extension`: adds user interface panels, header buttons, or task workflow hooks.
  - `connector`: connects an external tracker or service through an anti-corruption layer that maps external items into Meitheal tasks.
- Cross-context imports must use the `@domains/plugins` public barrel on the server. Browser code must never import server or SQLite modules.

### 2. Dual-Layer Browser Sandbox (No Host DOM or Server Execution)

Meitheal executes all plugin code inside strict browser sandboxes:

- **Logic sandbox:** Run `plugin.js` inside a hidden opaque-origin `<iframe sandbox="allow-scripts">` (`origin: null`) with `connect-src 'none'`. The logic sandbox has zero access to host DOM, cookies, `localStorage`, or direct `/api/*` requests. All communication uses per-mount token-verified `postMessage` JSON-RPC.
- **UI sandbox:** Render `index.html` inside `<iframe sandbox="allow-scripts allow-forms">` with `srcdoc`. Never grant `allow-same-origin` or `allow-top-navigation`. Inject a strict `<meta>` CSP and Meitheal Tabler CSS variables into the frame.
- **No server execution:** Meitheal does not support arbitrary server-side JavaScript or shell commands (no `nodeExecution`).

### 3. Runtime-Enforced Permissions and Mandatory Data-Sharing Disclosure

Every plugin must declare required capabilities in `manifest.json`:

- Map plugin permissions onto Meitheal `AgentScope` rules (`tasks:read`, `tasks:write`, `boards:read`, `storage:local`, `ui:header-button`, `ui:side-panel`, `ui:toast`, `http:outbound`, `secrets:use`).
- Enforce permissions in both the browser RPC bridge and server API routes.
- Bound every plugin action to the active user's board permissions. A plugin cannot elevate privileges beyond the signed-in user.
- Require a `dataSharing` object in `manifest.json`. Reject any plugin that lists a host in `allowedHosts` without disclosing it in `dataSharing.destinations`.
- Require explicit administrator re-consent when an updated plugin requests new permissions or hosts.

### 4. SSRF-Hardened Outbound HTTP Gateway and Write-Only Secrets

Plugins cannot bypass browser CORS or call private network services directly:

- Route outbound connector requests through `POST /api/plugins/:id/http`.
- Enforce the plugin `allowedHosts` list on every request.
- Require HTTPS for external hosts.
- Block loopback addresses, link-local addresses, cloud metadata endpoints, `supervisor`, and `hassio` hostnames.
- Block RFC 1918 private network ranges by default unless an administrator explicitly approves a self-hosted `userServer` target for that plugin.
- Store plugin credentials in a dedicated `plugin_secrets` SQLite table. Exclude `plugin_secrets` from JSON and CSV exports.
- Inject secrets on the server through `{{secret:key}}` header templates so raw secret values never enter plugin JavaScript or the browser DOM.

### 5. Hardened ZIP Archive Ingestion and Safe Mode

Only administrators can install, upgrade, or remove uploaded plugins:

- Validate uploaded ZIP archives with strict limits: `2 MB` maximum compressed size, `8 MB` maximum uncompressed size, `50` maximum files, and a `20:1` maximum compression ratio.
- Reject path traversal (`..`), absolute paths, symbolic links, and binary executables.
- Sanitize `icon.svg` files by removing `<script>` tags, event handlers, `<foreignObject>`, and external `href` references.
- Provide a global **Safe Mode** toggle in `#plugins-settings` that disables all plugins immediately without deleting plugin data.

### 6. Lazy-Loaded Host Runtime for Performance Budgets

Meitheal enforces strict client bundle and memory budgets for Home Assistant Green hardware (ADR 0021).

- Load `apps/web/src/lib/plugin-host.ts` dynamically only when at least one plugin is enabled.
- Add zero bytes to common and workspace client bundles when no plugins are active.

### 7. Licensing Boundary

In alignment with ADR 0022 (`AGPL-3.0-only`), plugins communicate with Meitheal only across the versioned JSON-RPC and HTTP boundary. Third-party plugins can use any license chosen by their author without modifying Meitheal core source code.

## Alternatives Considered

- **Merge plugins directly into Connected Services (`#connections-settings`):** Rejected. Core Home Assistant infrastructure requires trusted server credentials (`SUPERVISOR_TOKEN`) and tight lifecycle coupling. Mixing untrusted third-party ZIP packages with core infrastructure blurs trust boundaries and increases security risk.
- **Evaluate `plugin.js` with `new Function()` in the main window and use `allow-same-origin` iframes:** Rejected. This model violates Meitheal's CSP, exposes session credentials and Home Assistant APIs to plugin code, and makes permission declarations non-enforceable.
- **Run plugins on the Node.js server using `vm` or child processes:** Rejected. Node.js `vm` is not a security boundary, and child processes increase memory consumption on Home Assistant Green appliances while widening the attack surface.

## Consequences

- **Positive:**
  - Household administrators can install extensions and external connectors with clear permission and data-sharing visibility.
  - Faulty or malicious plugins cannot access session cookies, Home Assistant Supervisor tokens, or other plugins' secrets.
  - Base page load time and memory footprint stay unchanged when plugins are disabled.
  - External connectors follow one consistent, testable pattern instead of adding one-off backend integrations.
- **Negative / Risks:**
  - Plugins cannot directly manipulate arbitrary host DOM elements outside registered UI slots (header buttons, side panel, dialogs, toasts).
  - External APIs that require custom OAuth browser redirects need explicit host-level redirect handling in a future phase.
  - Contributors must maintain the versioned plugin RPC contract and OpenAPI routes as Meitheal evolves.

## Related

- [Plugin Development Guide](../kcs/plugin-development.md)
- [ADR 0004: Threat Model Baseline](0004-threat-model.md)
- [ADR 0020: Separate App, browser, A2A, and Home Assistant Core agent protocols](0020-agent-protocol-boundaries.md)
- [ADR 0021: Hardware, Memory, and UI Surface Architecture](0021-hardware-memory-and-ui-architecture.md)
- [ADR 0022: AGPL-3.0-only Source License with Commercial Licensing](0022-agpl-source-license.md)
