---
type: "Guide"
title: "API and Automation Guide"
description: "Maintain the API, event, and automation contracts."
---

# Agent & Automation Integration Guide

Meitheal builds API documentation and App MCP tool schemas from one OpenAPI and AsyncAPI source in `apps/web/`. Code contracts define the discovery manifests, Browser WebMCP tools, and Home Assistant Core MCP catalog.

## Build Pipeline

Generator scripts live under `apps/web/scripts/`.

- `predev` (`pnpm --filter @meitheal/web dev`): runs `generate:openapi`.
- `prebuild` (`pnpm --filter @meitheal/web build`): runs `generate:openapi` and `generate:asyncapi` before `astro build`.

Generated outputs (under `apps/web/`):

- `public/openapi.yaml` — OpenAPI 3.1 contract (post-processing sets `additionalProperties: false` and `x-strict: true`)
- `public/.well-known/jsondoc.json` — OpenAPI 3.1 JSON with ingress-aware relative server URL
- `public/asyncapi.yaml` — AsyncAPI 2.6 event contract
- `dist/` — Built production server bundle

### Registering API Routes and Events

To add or update an API route:

1. Add the operation under `paths` and its schemas under `components.schemas` in `apps/web/scripts/generate-openapi.mjs`.
2. Set `operationId`, `parameters`, `requestBody`, and `responses` on the operation.
3. Map the route method and path in `resolveAgentRouteScope()` inside `packages/domain-auth/src/agent-route-policy.ts`.
4. Add any assigned-task-safe sub-routes to `isAssignedTaskScopedRoute()` (unmapped routes return HTTP `403` for agent tokens).
5. Run `pnpm --filter @meitheal/web run generate:openapi`.

To add an async event:

1. Add the channel in `apps/web/scripts/generate-asyncapi.mjs` (`subscribe` for `sse/*`, `publish` with `bindings.http` for `webhook/*`).
2. Emit the event at runtime through `dispatchTaskEvent()` in `apps/web/src/lib/webhook-dispatcher.ts`.
3. Run `pnpm --filter @meitheal/web run generate:asyncapi` to update `public/asyncapi.yaml`.

### Registering Custom MCP Tools

`POST /api/mcp` builds tools dynamically from `openapi.yaml`. Exclude internal endpoints in `EXCLUDED_OPS` inside `apps/web/src/pages/api/mcp.ts`.

For tools that need custom logic beyond CRUD dispatch:

1. Register `(args, requestApi, agent) => Promise<Record<string, unknown>>` in `customHandlers`.
2. Add the required `AgentScope` (or `"write"` / `"read_and_write"` when `tasks:write:assigned` tokens may call it too; the API it reaches still enforces task assignment) to `customToolScopes`.
3. Add custom-only tools (`!routes.has(name)`) to `getCustomToolDescription()` and `getCustomToolSchema()`. Tools backed by OpenAPI inherit their schema from `openapi.yaml`.

## Agent Scopes & Token Policy

Create agent tokens in **Settings → Automation & AI → Agent Tokens** as a verified Home Assistant administrator. Authenticate external callers with `Authorization: Bearer mth_<64-hex>`. Tokens never inherit Home Assistant administrator headers.

| Scope | Capability |
|-------|------------|
| `tasks:read` | Read tasks, `GET /api/users` assignee directory, and `listMyTasks` |
| `tasks:propose` | Claim, release, or propose edits via `POST /api/tasks/{id}/handoff` |
| `tasks:write` | Create, update, reorder, NFC-complete, comment, link, track time, defer, and toggle reactions on tasks |
| `tasks:write:assigned` | Update only tasks assigned to `assigneeId` (`PUT`/`PATCH /api/tasks/{id}`, `deferral`, `comments`, `links`, `time`, `completeTask`, `handBackTask`; excludes reactions and comment deletion) |
| `tasks:delete` | Delete tasks and run `/api/tasks/clear-completed` or `/api/tasks/delete-completed` |
| `projects:read` | List projects (`GET /api/projects`) and read project details (`GET /api/projects/{id}`) |
| `projects:write` | Create, update, or delete projects |
| `search:read` | Search tasks and entities (`GET /api/search`, `searchTasks`, title lookup in `completeTask`) |
| `mcp:execute` | Access `GET /.well-known/mcp.json`, `POST /api/mcp` (`GET` returns `405 Allow: POST`), and `whoAmI` |
| `a2a:execute` | Access `GET /api/a2a/agent-card`, `/.well-known/agent-card.json`, `/.well-known/agent.json`, and stateless `/api/a2a/tasks/{id}` (`404`); `POST /api/a2a/message` also requires `search:read` |

- Deprecated legacy scopes (`settings:read`, `settings:write`, `webhooks:write`) grant no access; token management requires a real Home Assistant administrator session.
- **Home Assistant Core recommendation**: Create a token with `tasks:read`, `tasks:write`, `tasks:delete`, and `search:read`. Add `mcp:execute` if calling `POST /api/mcp`.
- Percent-encoded `/api/` and `/.well-known/` paths (for example `/%61pi/tasks` or `/.well-known/%6dcp.json`) return HTTP `404`.

## Core Agent Flows

- **Create and update tasks**: `POST /api/tasks/create` accepts `title`, optional `description` (or `frameworkPayload.description`), and `assigned_to` (`ha_` or `custom_` ID). It returns `201` on create and `200` on idempotent replay (`result.idempotentReplay`). Update tasks through `PUT` or `PATCH /api/tasks/{id}`.
- **Agent handoff and Review**: Assign tasks to human members or AI agents.
  - Agents call `whoAmI`, `listMyTasks`, and `handBackTask` over MCP, or call `POST /api/tasks/{id}/handoff` (`claim`, `release`, `propose`) to stage proposals.
  - Settings shows agent handoff status. `/review` shows saved proposals live, and service workers purge cached Review pages on activation.
- **Home Assistant Companion MCP & Events**:
  - The custom integration exposes a 16-tool admin-only JSON-RPC endpoint at `POST /api/meitheal/mcp` (`mcp_server.py`). It negotiates MCP `2024-11-05` through `2025-11-25` and rejects unknown tool fields. Both `POST /api/mcp` and `POST /api/meitheal/mcp` accept `q` or `query` on `searchTasks`. Both accept canonical task statuses (`backlog`, `pending`, `active`, `complete`) and Home Assistant aliases (`todo`, `in_progress`, `done`). When `status` is `done` or `complete` and you omit `include_completed`, `searchTasks` sets `include_completed=1`. App MCP link tools use path `id` (`linkTask` takes `{ id, target_task_id, link_type }`, `unlinkTask` takes `{ id, link_id }`, and `getTaskLinks` takes `{ id }`). Core MCP uses `source_task_id` on `linkTask` and `task_id` on `unlinkTask` and `getTaskLinks`.
  - Outbound Core event bus payloads include `domain: "meitheal"`, `source: "meitheal"`, and an ISO timestamp (`meitheal_task_created`, `meitheal_task_updated`, `meitheal_task_completed`, `meitheal_task_deleted`, `meitheal_task_overdue`, `meitheal_task_commented`, `meitheal_area_updated`). Inspect the Home Assistant Core event bus for `domain: "meitheal"` and the task ID to diagnose automations. Events from other domains never activate Meitheal triggers.
- **Reactions**: `POST /api/tasks/{id}/reactions` and `POST /api/tasks/{id}/comments/{commentId}/reactions` require `Content-Type: application/json` (`415` otherwise) and `tasks:write` scope. The maximum request body size is 1 KiB (`413`). Reaction text requires 1–16 valid NFC characters without control or bidi characters (`400`). Send `DELETE` with `/{reactionId}` appended to remove a reaction. `GET /api/tasks/reaction-counts?ids=...` accepts up to 100 IDs and omits zero-count tasks.
- **Idempotency (`Idempotency-Key`)**: Meitheal supports `Idempotency-Key` on `tasks:write` and `tasks:delete` task routes, including `tasks:write:assigned` writes mapped to `tasks:write`. Excluded routes (`PATCH /api/tasks/{id}/deferral`, reaction endpoints, `/api/agent-tokens`, and `handoff`) ignore `Idempotency-Key`. Keys accept up to 255 characters without control characters (`400`). The maximum request body size is 64 KiB (`413`), and cached responses cap at 16 KiB. Each process caches up to 256 entries for 24 hours (`503` when full) and sets `Idempotency-Key-Status: processed | cached`. Distinct payloads hash separately, and in-flight duplicates return HTTP `409`. `taskRetryKey()` namespaces keys by `"task-v2"` and caller principal.

## Hand a task to an AI agent

An agent assignee is an AI agent, such as Claude or Codex, that appears in the assignee list beside the people in your household. It works through one agent token, so the tasks assigned to it are that token's own tasks.

1. Open **Settings → Automation & AI → Agent Tokens** as a Home Assistant administrator and choose **New Token**.
2. Under **Acts as**, choose **New agent assignee…** and name the agent. Meitheal selects the scopes an agent needs: `mcp:execute`, `tasks:read`, `tasks:write:assigned` and `search:read`.
3. Create the token and store it in the agent's MCP client. See [MCP and A2A setup](webmcp-a2a-setup.md).
4. Assign a task to the agent from any assignee menu. Agents are marked **AI agent**.

Over MCP the agent uses these tools. Its identity always comes from the token, never from an argument.

| Tool | Result |
| --- | --- |
| `whoAmI` | The token name, its scopes, the agent assignee it acts as, and whether it may change any task or only assigned tasks. |
| `listMyTasks` | The open tasks assigned to the agent. Pass `include_completed` or a `status` to widen the list. |
| `getTask`, `getTaskComments` | A task and its discussion. |
| `addTaskComment` | The agent's answer, shown as **Automation: _token name_**. |
| `updateTask`, `completeTask` | A change to a task assigned to the agent. |
| `handBackTask` | Posts an optional note, then returns the task to whoever held it before the agent. Pass `to` to name another assignee, or `null` to leave it unassigned. |

With `tasks:write:assigned`, a request to change a task assigned to someone else returns HTTP 403 with the problem type `task-not-assigned`. The agent cannot create or delete tasks. Grant `tasks:write` only to automation that must change any task. A token can act as an agent assignee only, never as a person. Deleting an agent assignee unassigns its tasks and detaches its tokens.

Task history records the token name and the actor type `agent` for each field an agent changes. When an agent comments or hands a task back, Meitheal sends a notification through the channels enabled in **Settings → Notifications** and emits a `task.commented` webhook event for agent comments.

## Protocol & Traceability Contracts

### `POST /api/mcp`

- Send `Authorization: Bearer mth_<64-hex>` with `mcp:execute` on every call. When an `Origin` header is present, `matchesOrigin()` enforces the ingress or `SITE_URL`/localhost origin (`403` otherwise). Disabled MCP returns `404` or `503`.
- Legacy callers use JSON-RPC 2.0 `initialize`, `ping`, `tools/list`, `tools/call`, and `notifications/initialized` or `notifications/cancelled` (`202` empty body when `id` is absent). `GET` and `HEAD /api/mcp` return `405 Allow: POST`.
- Modern MCP `2026-07-28` callers use `server/discover`, `ping`, `tools/list`, and `tools/call` (modern `initialize` returns `-32601` / HTTP `404`). Modern calls require matching `Mcp-Protocol-Version`, `Mcp-Method`, `params._meta["io.modelcontextprotocol/protocolVersion"]`, object `clientCapabilities`, and `Mcp-Name` on `tools/call`. The maximum request body size is 1 MiB (`413`).

### Traceability Headers

Send these headers from external systems (n8n, Node-RED, AI agents):

```bash
curl -X POST http://localhost:3000/api/tasks/create \
  -H "Authorization: Bearer mth_<token>" \
  -H "Content-Type: application/json" \
  -H "X-Automation-Source: n8n" \
  -H "X-Agent-Id: nightly-triage-v2" \
  -d '{"title": "Review overdue items"}'
```

- `X-Automation-Source`: Send an allowlisted value (`browser`, `webmcp`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron`). Meitheal logs this value in `metadata.automation_source`.
- `X-Agent-Id`: Send up to 128 characters (`[A-Za-z0-9._-]`). Meitheal truncates longer values and logs the result in `metadata.agent_id`.
- `traceparent`: W3C format `00-<32-hex>-<16-hex>-<2-hex>`. Middleware generates a new trace context when `traceparent` is absent or invalid.
- Outbound webhooks include CloudEvents (`ce-*`) headers and HMAC-SHA256 `x-meitheal-signature` over the JSON payload.

## Error & Rate-Limit Behavior

- Shared helpers in `apps/web/src/lib/api-response.ts` (`apiProblem()`, `apiError()`, `apiValidationError()`, `apiRateLimited()`) return `application/problem+json` (RFC 9457) with `error` and optional `invalidParams`. Legacy handlers in `pages/api/tasks/` can return plain `application/json` `{ "error": "..." }`.
- API and discovery responses emit `RateLimit`, `RateLimit-Policy`, and `x-ratelimit-*` headers (`300 requests/min` general quota). `/api/mcp` and `/accept-proposal` also enforce a `60 requests/min` bot quota (HTTP `429` with `Retry-After`). Early middleware `401`, `403`, and `503` rejections omit rate-limit headers.

## Discovery Endpoints

| URL | Purpose |
|-----|---------|
| `GET /openapi.yaml` | Full OpenAPI 3.1 spec |
| `GET /.well-known/jsondoc.json` | OpenAPI 3.1 JSON with ingress-aware server URL |
| `GET /asyncapi.yaml` | AsyncAPI 2.6 event spec |
| `GET /.well-known/mcp.json` | MCP discovery and ingress-aware endpoint |
| `POST /api/mcp` | JSON-RPC 2.0 MCP server |
| `GET /api/a2a/agent-card` | Agent-to-Agent discovery |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| MCP discovery or requests return 404 | MCP is disabled | Enable MCP in **Settings → Automation & AI → Agent Protocols**. Select **Save Agent Protocol Settings**. |
| MCP returns an empty tool list | `openapi.yaml` is missing | Run `pnpm --filter @meitheal/web run generate:openapi` |
| Tool definitions appear stale in dev | 30s spec cache TTL | Wait 30 seconds or restart the dev server |
| `X-Automation-Source` logged as `unknown` | Header value not in allowlist | Use an allowlisted source string |
| Missing `trace_id` in structured logs | `traceparent` invalid or bypassed | Send valid W3C `traceparent`; middleware generates one automatically |
