---
type: "Guide"
title: "API and Automation Guide"
description: "Maintain the API, event, and automation contracts."
---

# Agent & Automation Integration Guide

Meitheal provides agent discovery, API documentation, and MCP tool execution generated from one OpenAPI and AsyncAPI source in `apps/web/`.

## Build Pipeline

Generator scripts live under `apps/web/scripts/`.

- `predev` (`pnpm --filter @meitheal/web dev`): runs `generate:openapi`.
- `prebuild` (`pnpm --filter @meitheal/web build`): runs `generate:openapi` and `generate:asyncapi` before `astro build`.

Generated outputs (under `apps/web/`):

- `public/openapi.yaml` — OpenAPI 3.1 contract (`additionalProperties: false` enforced by post-processing, `x-strict: true`)
- `public/.well-known/jsondoc.json` — OpenAPI 3.1 JSON with ingress-aware relative server URL
- `public/asyncapi.yaml` — AsyncAPI 2.6 event contract
- `dist/` — Built production server bundle

### Registering API Routes and Events

1. **Add or update an API route**:
   - Add the operation under `paths` (and schemas under `components.schemas`) in `apps/web/scripts/generate-openapi.mjs`. Set `operationId`, `parameters`, `requestBody`, and `responses`.
   - Map the route method and path in `packages/domain-auth/src/agent-route-policy.ts` inside `resolveAgentRouteScope()`. Add assigned-task-safe sub-routes to `isAssignedTaskScopedRoute()`. Unknown routes fail closed (HTTP 403) for agent tokens.
   - Rebuild or run `pnpm --filter @meitheal/web run generate:openapi`.
2. **Add an async event**:
   - Add the channel to `apps/web/scripts/generate-asyncapi.mjs`: use `subscribe` (without HTTP bindings) for `sse/*` channels and `publish` with `bindings.http` for `webhook/*` channels.
   - Emit the event at runtime through `dispatchTaskEvent()` in `apps/web/src/lib/webhook-dispatcher.ts`, and regenerate `public/asyncapi.yaml` via `pnpm --filter @meitheal/web run generate:asyncapi`.

### Registering Custom MCP Tools

`POST /api/mcp` generates tools dynamically from `openapi.yaml`. Exclude internal endpoints in `EXCLUDED_OPS` inside `apps/web/src/pages/api/mcp.ts`.

For tools that need custom logic beyond CRUD dispatch:

1. Register `(args, requestApi, agent) => Promise<Record<string, unknown>>` in `customHandlers`.
2. Add the tool's required `AgentScope` to `customToolScopes`. If `tasks:write:assigned` tokens may call it, add the tool name to `assignedCustomTools`.
3. For custom-only tools absent from `openapi.yaml` (`!routes.has(name)`), add entries to `getCustomToolDescription()` and `getCustomToolSchema()`. Tools backed by OpenAPI inherit their schema from `openapi.yaml`.

## Agent Scopes & Token Policy

Authenticate external callers with `Authorization: Bearer mth_<64-hex>` issued in Settings -> Automation & AI -> Agent Tokens (admin ingress required). Tokens never inherit HA admin headers.

| Scope | Capability |
|-------|------------|
| `tasks:read` | Read tasks, `GET /api/users` assignee directory, and `listMyTasks` |
| `tasks:propose` | Claim, release, or propose edits via `POST /api/tasks/{id}/handoff` |
| `tasks:write` | Create, update, reorder, NFC-complete, comment, link, track time, defer, and toggle reactions on tasks |
| `tasks:write:assigned` | Update only tasks assigned to the token's `assigneeId` (includes `PUT`/`PATCH /api/tasks/{id}`, `PATCH .../deferral`, `POST .../comments`, `PATCH .../comments/{commentId}`, `POST`/`DELETE .../links`, `POST .../time`, `completeTask`, and `handBackTask`; excludes reactions and comment deletion) |
| `tasks:delete` | Delete tasks and run `/api/tasks/clear-completed` or `/api/tasks/delete-completed` |
| `projects:read` | List projects (`GET /api/projects`) and read project details (`GET /api/projects/{id}`) |
| `projects:write` | Create, update, or delete projects |
| `search:read` | Search tasks and entities (`GET /api/search`, `searchTasks`, title lookup in `completeTask`) |
| `mcp:execute` | Access `POST /api/mcp` (`GET` returns `405 Allow: POST`) and `whoAmI` |
| `a2a:execute` | Read `GET /api/a2a/agent-card` and `GET /api/a2a/tasks/{id}`; `POST /api/a2a/message` also requires `search:read` |

- Deprecated legacy scopes (`settings:read`, `settings:write`, `webhooks:write`) perform no-ops; token management requires a real HA administrator session.
- **Home Assistant Core recommendation**: Create a token with `tasks:read`, `tasks:write`, `tasks:delete`, and `search:read`. Add `mcp:execute` if calling `POST /api/mcp`.
- Percent-encoded `/api/` prefixes on app routes (for example `/%61pi/tasks`) return HTTP 404.

## Core Agent Flows

- **Task create/update**: `POST /api/tasks/create` accepts `title`, optional top-level `description` (uses `frameworkPayload.description` when `description` is absent), and `assigned_to` (`ha_` or `custom_` ID). Return codes: `201` on create, `200` on idempotent replay (`result.idempotentReplay`); task updates use `PUT` or `PATCH /api/tasks/{id}`.
- **Agent handoff and Review**: Assign tasks to human members or AI agents.
  - Agents use `whoAmI`, `listMyTasks`, and `handBackTask` over MCP, or `POST /api/tasks/{id}/handoff` (`action: "claim" | "release" | "propose"` with `lease`, `summary`, and `updates`) to stage proposals.
  - Settings shows agent handoff status. `/review` shows saved proposals live; service workers purge cached Review pages on activation.
- **Home Assistant Companion MCP & Events**:
  - The custom integration exposes a separate 16-tool admin-only JSON-RPC endpoint at `POST /api/meitheal/mcp` (`integrations/home-assistant/custom_components/meitheal/mcp_server.py`).
  - App events sent to the Home Assistant Core event bus include `domain: "meitheal"`, `source: "meitheal"`, and an ISO timestamp (`meitheal_task_created`, `meitheal_task_updated`, `meitheal_task_completed`, `meitheal_task_deleted`, `meitheal_task_overdue`, `meitheal_task_commented`, `meitheal_area_updated`). To diagnose HA automations, inspect the Home Assistant Core event bus for that domain marker and expected task ID. Events from other domains do not activate Meitheal triggers.
- **Reactions**: `POST /api/tasks/{id}/reactions` and `POST /api/tasks/{id}/comments/{commentId}/reactions` require `Content-Type: application/json` (`415` otherwise), max 1 KiB body (`413`), valid NFC emoji or reaction text (1–16 chars) without control/bidi characters (`400`), and `tasks:write` scope (`tasks:write:assigned` cannot toggle reactions). Send `DELETE` with `/{reactionId}` appended to remove a reaction. `GET /api/tasks/reaction-counts?ids=...` accepts up to 100 comma-separated IDs and omits tasks with zero reactions.
- **Idempotency (`Idempotency-Key`)**: Supported on `tasks:write` and `tasks:delete` task routes (including `tasks:write:assigned` writes that map to `tasks:write` in `resolveAgentRouteScope()`, such as task updates, comments, links, and time entries). Excluded routes (`PATCH /api/tasks/{id}/deferral`, reaction endpoints, and `tasks:propose` / `handoff`) ignore `Idempotency-Key`. Key max length is 255 characters without control characters (`400` on invalid key), request body max size is 64 KiB (`413`), cached JSON response max size is 16 KiB, cache capacity is 256 entries per process (`503` when full), TTL is 24 hours, and cached responses emit `Idempotency-Key-Status: processed | cached`. Different payloads hash to distinct cache keys (cache miss, not `409`); HTTP `409` is returned only while an identical concurrent request is in flight. `taskRetryKey()` namespaces keys by `"task-v2"` and caller principal.

## Protocol & Traceability Contracts

### `POST /api/mcp`

- Require `Authorization: Bearer mth_<64-hex>` with `mcp:execute` on every call; when an `Origin` header is present, `matchesOrigin()` requires forwarded proto+host behind ingress or `SITE_URL`/localhost+host directly (`403` otherwise). Disabled MCP returns `404`/`503`.
- Accepts legacy JSON-RPC 2.0 `initialize` (non-modern requests only), `ping`, `tools/list`, `tools/call`, and `notifications/initialized` / `notifications/cancelled` (`202` empty body when `id` is absent on non-modern requests), plus modern `server/discover`. `GET`/`HEAD /api/mcp` return `405 Allow: POST`.
- Modern MCP requests (`Mcp-Protocol-Version: 2026-07-28`, `params._meta["io.modelcontextprotocol/protocolVersion"]`, or `method === "server/discover"`) require matching `Mcp-Protocol-Version`, `Mcp-Method`, `params._meta["io.modelcontextprotocol/protocolVersion"]`, object `params._meta["io.modelcontextprotocol/clientCapabilities"]`, and `Mcp-Name` on `tools/call` (modern `initialize` returns `-32601` / HTTP `404`). Max request body is 1 MiB (`413`).

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

- `X-Automation-Source`: Allowlisted (`browser`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron`). Logged in `metadata.automation_source`.
- `X-Agent-Id`: Truncated to 128 chars (`[A-Za-z0-9._-]`). Logged in `metadata.agent_id`.
- `X-Meitheal-Origin-Kind`: Authenticated `Bearer mth_...` callers only (ignored on spoofing/unauthenticated requests); verified origin kind (`conversation_agent`, `ha_automation`, `ha_script`, `webhook`, `mcp`, `agent_token`) stored in `task_activity_log` provenance.
- `X-Meitheal-Origin-Name`: Human-readable automation/conversation agent label (control chars stripped, max 120 chars; e.g., `Gemini Conversation`, `Nightly Kitchen Reset`).
- `X-Meitheal-Origin-Target`: Optional root-relative deep-link path (must start with single `/` and resolve within origin; e.g., `/config/automation/edit/...`).
- `traceparent`: W3C format `00-<32-hex>-<16-hex>-<2-hex>`. Middleware generates a new trace context when `traceparent` is absent or invalid.
- Outbound webhooks include CloudEvents (`ce-*`) headers and HMAC-SHA256 `x-meitheal-signature` over the JSON payload.

## Error & Rate-Limit Behavior

- Shared helpers in `apps/web/src/lib/api-response.ts` (`apiProblem()`, `apiError()`, `apiValidationError()`, `apiRateLimited()`) emit `application/problem+json` (RFC 9457) with a backward-compatible `error` field and optional `invalidParams`. Note that some legacy handlers in `pages/api/tasks/` still return plain `application/json` `{ "error": "..." }`.
- API responses that complete `apps/web/src/middleware.ts` emit `RateLimit`, `RateLimit-Policy`, and `x-ratelimit-*` headers (`300 requests/min` general quota on allowed responses, including non-429 responses on bot routes; `/api/mcp` and `/accept-proposal` enforce a `60 requests/min` bot quota returning HTTP `429`, `Retry-After`, and `60/min` policy headers when exceeded). Early middleware `401`/`403`/`503` rejections return without rate-limit headers.

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
| MCP discovery or requests return 404 | MCP is disabled | Enable the MCP toggle in Settings -> Automation & AI -> Agent Protocols |
| MCP returns an empty tool list | `openapi.yaml` is missing | Run `pnpm --filter @meitheal/web run generate:openapi` |
| Tool definitions appear stale in dev | 30s spec cache TTL | Wait 30 seconds or restart the dev server |
| `X-Automation-Source` logged as `unknown` | Header value not in allowlist | Use an allowlisted source string |
| Missing `trace_id` in structured logs | `traceparent` invalid or bypassed | Send valid W3C `traceparent`; middleware generates one automatically |
