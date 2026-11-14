---
type: "Decision"
title: "Separate App, browser, A2A, and Home Assistant Core agent protocols"
description: "Defines bounded contexts, authorization rules, and interoperability across MCP, WebMCP, A2A, and Home Assistant Core."
---

# Separate App, browser, A2A, and Home Assistant Core agent protocols

Date: 2026-11-12
Status: Accepted

Meitheal supports four agent protocol boundaries with distinct trust models. Keep protocol contracts and availability gates inside `apps/web/src/domains/agents/`. Server routes import `@domains/agents`. Browser scripts import `@domains/agents/webmcp-protocol` so SQLite modules never enter client bundles.

- **App MCP (`POST /api/mcp` and `/.well-known/mcp.json`)**: App MCP serves external network agents. Callers send `Authorization: Bearer mth_<64-hex>` with `mcp:execute` and per-tool scopes from `@meitheal/domain-auth`. It builds schemas from `/openapi.yaml` and supports MCP `2026-07-28` (`server/discover`) plus `initialize` (`2025-03-26` to `2025-11-25`).
- **WebMCP (`document.modelContext`)**: WebMCP runs in `apps/web/src/lib/webmcp-controller.ts` and starts disabled (`agent-protocols-webmcp-enabled`). It registers read-only `meitheal_search_tasks` and `meitheal_open_tasks` tools in administrator browser sessions with `AbortSignal` teardown. Each call rechecks the saved preference over HTTP and sends `X-Automation-Source: webmcp` on search requests.
- **A2A (`POST /api/a2a/message` and `/.well-known/agent-card.json`)**: A2A `1.0` exposes only the read-only `task-search` skill. Managed-ingress deployments require ingress or `a2a:execute` for discovery. Execution requires `a2a:execute` and `search:read`, returns up to eight active task titles with links, and creates no tasks.
- **Home Assistant Core (`integrations/home-assistant/`)**: The Core integration calls the App over HTTP with its enrolled token. It exposes the **Meitheal Tasks** Assist LLM API and the administrator-only `POST /api/meitheal/mcp` endpoint. Core MCP negotiates `2024-11-05` through `2025-11-25` and accepts canonical statuses plus Home Assistant aliases (`todo`, `in_progress`, `done`).

External `mth_*` tokens never inherit Home Assistant administrator sessions or access `/api/ha/*` routes backed by `SUPERVISOR_TOKEN`. Administrators review and approve agent proposals in `/review`. [Setup guide](../kcs/webmcp-a2a-setup.md)
