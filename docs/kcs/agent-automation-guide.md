---
type: "Guide"
title: "API and Automation Guide"
description: "Maintain the API, event, and automation contracts."
---

# API and Automation Guide

> KCS runbook for the build-time OpenAPI, AsyncAPI, MCP, and observability pipeline.

Agent handoff status is shown in Settings. Review displays saved proposals and fetches them live. Service workers purge previously cached Review pages during activation.

App events sent to the Home Assistant event bus carry `domain: "meitheal"` and `source: "meitheal"` with an ISO timestamp. Native device triggers filter by the domain marker. When diagnosing a trigger, inspect the event on Core's event bus and confirm that marker and the expected task ID; events from other domains must not activate a Meitheal trigger.

## Build Pipeline

```bash
# Runs automatically during `pnpm build`:
npm run generate:openapi   # → public/openapi.yaml and public/.well-known/jsondoc.json
npm run generate:asyncapi  # → public/asyncapi.yaml (5 SSE + 6 webhook channels)
astro build                # → dist/
```

## Adding a New API Route

1. Create the Astro API route in `apps/web/src/pages/api/`
2. Add the route to the `paths` object in `apps/web/scripts/generate-openapi.mjs`
3. If the route introduces a new domain object, add it to the `schemas` object
4. Run `npm run generate:openapi` to verify
5. For agent access, explicitly map the route and method to a scope in `packages/domain-auth/src/agent-route-policy.ts`. MCP only offers mapped operations permitted by the caller’s scopes.

## Adding a New Event

1. For SSE events: add a channel under `sse/` in `generate-asyncapi.mjs`
2. For webhook events: add a channel under `webhook/` in `generate-asyncapi.mjs`
3. Run `npm run generate:asyncapi` to verify

## Adding a Custom MCP Tool

For tools that need special logic beyond simple CRUD dispatch:

1. Add a handler to the `customHandlers` Map in `apps/web/src/pages/api/mcp.ts`
2. Add the tool's description to `getCustomToolDescription()`
3. Add the tool's input schema to `getCustomToolSchema()`
4. Assign the tool an explicit scope. Every downstream API request enforces its own scope.

## Scoped API access

Open Meitheal through Home Assistant as an administrator, then go to **Settings → Automation & AI → Agent Tokens**. Give each client its own token and select the scopes for its operations. Copy the token during creation and store it in the client’s secret storage. Send it as an `Authorization: Bearer` header. A token is required for MCP and needs both `mcp:execute` and the scope of the tool it calls.

Keep tokens out of examples, logs, and reports. Use sample tasks to test a connection. Ask the installation owner before you send task details or household data to an external service.

| Operation | Scope |
|-----------|-------|
| List tasks, read a task, or read its links | `tasks:read` |
| Read task or comment reactions and board reaction counts | `tasks:read` |
| Update, comment on, log time on, complete, or hand back a task assigned to the token's agent | `tasks:write:assigned` |
| Create or update any task, or add and remove their links | `tasks:write` |
| Add or remove your own task or comment reactions | `tasks:write` |
| Delete tasks, including bulk removal of completed tasks | `tasks:delete` |
| Query universal search | `search:read` |
| List and change projects | `projects:read` and `projects:write`, respectively |

An invalid, revoked, or expired token returns HTTP 401. A valid token without permission returns HTTP 403. Use the Home Assistant administrator session to change scopes or revoke credentials. Existing settings and webhook scopes have no permitted operations in the current policy. To connect Home Assistant Core, create a token with all three task scopes and `search:read`.

Use the literal `/api/` prefix in API URLs. Encoded spellings of that prefix that resolve to an API route return HTTP 404.

### Find, create, and complete tasks

1. Find tasks with `GET /api/search?q=…&scope=tasks` and use a result's task ID for follow-up requests.
2. Create a task with `POST /api/tasks`. The response includes its ID at the top level.
3. Update the task with `PATCH /api/tasks/{id}`. Set `status` to `complete` when the work is done.

The Home Assistant `meitheal.create_task` action stores its optional instructions in the task’s Description. The calendar-aware `POST /api/tasks/create` endpoint accepts a top-level `description` and falls back to `frameworkPayload.description` for existing integrations.

### Hand a task to an AI agent

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

### Read saved agent proposals

Open `/review` through the installed App to read saved proposals and their proposed changes. See [Agent task approvals](agent-task-approvals.md) for a token that may only suggest changes for a person to accept.

### Read or change reactions

Use `GET` or `POST` on `/api/tasks/{id}/reactions` for a task, or `/api/tasks/{id}/comments/{commentId}/reactions` for a comment. A verified Home Assistant user or scoped agent can send a JSON `content` value with up to 16 Unicode code points after normalization. Repeating the same reaction as the same author returns the existing reaction ID. To remove your own reaction, send `DELETE` to the same collection path with the reaction ID appended.

Lists contain up to 50 entries and a `next_cursor` for older entries. Use `GET /api/tasks/reaction-counts?ids=…` with up to 100 comma-separated task IDs for card counts. This response can omit tasks with zero reactions.

### Retry a task mutation

For an authenticated task mutation, send the same `Idempotency-Key` and resend the same method, path, query, content type, and body when retrying. The retry key is limited to 255 characters. Retryable request bodies are limited to 64 KiB. A matching request that is still running returns HTTP 409. The server can replay a recent successful JSON response of up to 16 KiB, with up to 256 entries held per process. Calendar-aware task creation also stores the scoped retry digest in SQLite.

Treat the first request after upgrading as a new attempt if it used a legacy, unscoped key. Use a new key for new work. Standalone callers without a verified identity and callers on older Supervisor versions without trusted ingress identity should check the task list before resubmitting.

## Agent Traceability

External systems should include these headers for observability:

```bash
curl -X POST http://localhost:4321/api/tasks/create \
  -H "Content-Type: application/json" \
  -H "X-Automation-Source: n8n" \
  -H "X-Agent-Id: morning-briefing-workflow" \
  -H "traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" \
  -d '{"title": "Review weekly goals"}'
```

Valid `X-Automation-Source` values: `browser`, `n8n`, `nodered`, `mcp`, `agent`, `a2a`, `ha`, `api`, `webhook`, `cron`.

### W3C Traceparent

The `traceparent` header follows W3C Trace Context: `{version}-{traceId}-{spanId}-{traceFlags}`. When absent, middleware generates a new trace context. Trace IDs appear in structured logs (`trace_id`, `span_id`) for Grafana Alloy correlation.

### CloudEvents

All outbound webhooks include CNCF CloudEvents 1.0 headers (binary content mode): `ce-specversion`, `ce-id`, `ce-type` (e.g., `io.meitheal.task.created`), `ce-source`, `ce-time`, `ce-subject`. n8n/Node-RED parse these natively.

### JSON-LD

`<JsonLd>` component injects `<script type="application/ld+json">` with `SoftwareApplication` schema by default. Pages can pass custom schemas via the `jsonLd` prop on Layout.

### Strict Schemas

OpenAPI schemas enforce `additionalProperties: false` via post-processing in `generate-openapi.mjs`. The spec root has `x-strict: true`.

### RFC 9457 Problem+JSON Errors

All API errors return `application/problem+json` (RFC 9457). Agents can self-correct by reading `invalidParams`:

```json
{
  "type": "https://meitheal.local/problems/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "2 fields failed validation",
  "traceId": "0af7651916cd43dd8448eb211c80319c",
  "invalidParams": [
    { "name": "title", "reason": "Required" },
    { "name": "priority", "reason": "Must be between 1 and 5" }
  ]
}
```

Helpers: `apiError()` (backward-compat), `apiProblem()` (full control), `apiValidationError(zodError)` (Zod mapping), `apiRateLimited()` (429s).

### IETF Rate Limit Headers

All API responses include dual rate limit headers:

| Header | Standard | Example |
|--------|----------|---------|
| `RateLimit` | IETF draft-10 | `limit=300, remaining=299, reset=60` |
| `RateLimit-Policy` | IETF draft-10 | `300;w=60` |
| `x-ratelimit-limit` | Legacy | `300` |
| `x-ratelimit-remaining` | Legacy | `299` |
| `x-ratelimit-reset` | Legacy | `1711133880` (epoch) |
| `Retry-After` | RFC 7231 (on 429) | `60` |

429 responses return problem+json. Two tiers: 300/min general, 60/min bot endpoints.

## Discovery Endpoints

| URL | Purpose |
|-----|---------|
| `GET /openapi.yaml` | Full OpenAPI 3.1 spec |
| `GET /.well-known/jsondoc.json` | Same API operations as OpenAPI 3.1 JSON. The relative server URL retains the App's ingress path. |
| `GET /asyncapi.yaml` | AsyncAPI 2.6 event spec |
| `GET /.well-known/mcp.json` | Current MCP discovery and ingress-aware endpoint |
| `POST /api/mcp` | JSON-RPC 2.0 MCP server |
| `GET /api/a2a/agent-card` | Agent-to-Agent discovery |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| MCP discovery or authenticated requests return 404 | MCP is disabled | Check the MCP toggle in Settings → Automation & AI → Agent Protocols |
| MCP returns empty tools list | `openapi.yaml` not found | Run `npm run generate:openapi` |
| Tool definitions stale in dev | 30s cache TTL | Wait or restart dev server |
| `X-Automation-Source` logged as `unknown` | Value not in allowlist | Use one of the documented values above |
| CloudEvents headers missing | Old `webhook-emitter.ts` | Rebuild; headers are always emitted |
| `trace_id` missing in logs | No `traceparent` header | Middleware auto-generates; check log schema |
