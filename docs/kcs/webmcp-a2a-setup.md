# Agent protocol setup

## Available surfaces

| Surface | Status | Contract |
| --- | --- | --- |
| Astro MCP | Available | Generated tools at `POST /api/mcp`; dynamic discovery at `GET /.well-known/mcp.json` |
| A2A | Available | Scoped A2A 1.0 JSON-RPC task-title search; synchronous direct messages only |
| WebMCP | Browser dependent | Opt-in registration of task search and task-view navigation |
| Home Assistant integration | Available | HA services, todo/sensor entities and Assist LLM API tools; no separate registered MCP server |

## MCP

The `agent-protocols-mcp-enabled` setting controls discovery and every MCP
operation, including initialization, tool listing and execution. Disabled
requests return 404. If protocol configuration cannot be read, requests return
503 instead of silently bypassing the switch.

Use `tools/list` for actual tool names, descriptions and schemas; discovery's
`toolCount` comes from the same generated inventory. Counts are not fixed in
this guide. Task creation uses the canonical task API and retains priority,
due date and description. Completion checks the underlying write response for
both task ID and title inputs; a denied or failed write is an MCP error.

Home Assistant ingress uses Supervisor authentication. Optional agent tokens
must include `mcp:execute` and the scopes needed by the underlying operation.
A token that can execute MCP but lacks `tasks:write` cannot complete a task.
Standalone transport security follows the configured deployment boundary;
discovery does not claim anonymous access or mandatory bearer authentication
for every deployment.

## A2A

The A2A switch controls Agent Card discovery and the message endpoint. Both
`/.well-known/agent.json` and `/.well-known/agent-card.json` serve the same card
as `/api/a2a/agent-card` without redirects. Links include the current ingress
path. Cards advertise exactly one read-only skill, `task-search`.

Send `POST /api/a2a/message` with `Content-Type: application/json`,
`A2A-Version: 1.0` (or the same `A2A-Version` query parameter), and a valid
Meitheal agent token with **both** `a2a:execute` and `search:read`. An HA browser
session alone does not authorize A2A execution. Example JSON-RPC body:

```json
{
  "jsonrpc": "2.0",
  "id": "search-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "message-1",
      "role": "ROLE_USER",
      "parts": [{ "text": "heating" }]
    }
  }
}
```

A single JSON part, `{ "data": { "query": "heating", "skill": "task-search" } }`,
is also accepted. Search terms are 1–160 trimmed characters; request bodies
are limited to 16 KiB. Results contain up to eight active task titles, IDs and
links, without task descriptions. `configuration.acceptedOutputModes` can
select `application/json` or `text/plain`.

Results are direct `result.message` values, never invented asynchronous tasks.
`GetTask` and `CancelTask` report task-not-found; `ListTasks` is empty. Legacy
`GET /api/a2a/tasks/{id}` and cancellation URLs return 404. Streaming,
subscriptions, extended cards, other skills and push notifications return
explicit protocol errors. No task mutation or background delegation occurs.

## WebMCP browser tools

The WebMCP preference is off by default. When enabled, a browser exposing
`modelContext.registerTool` and `modelContext.unregisterTool` receives `meitheal_search_tasks` and
`meitheal_open_tasks`. The first uses the existing title-only search API; the
second opens a Kanban, Table, Calendar or Timeline task view. Both use the
current browser session and preserve ingress paths.

Settings displays registration success only after both tools register. Browsers
without the API show an unavailable status while retaining the preference.
Disabling aborts execution and explicitly removes both tools from the browser
registry. Page changes and development HMR retire previous
registrations. Other tabs refresh after a preference-change notification; each
execution rechecks the persisted preference so stale tool handles cannot bypass
a disabled setting. Failed reads prevent execution. These browser tools do not
provide a remote MCP endpoint or task mutation.

## Troubleshooting

1. For MCP 404, check the MCP setting through Settings. For 503, inspect database
   health and recover the settings store before retrying.
2. For tool errors, inspect the underlying HTTP error and token scopes. Do not
   retry a rejected mutation as though it succeeded.
3. For A2A 401/403, check the token and both scopes. For version errors, send
   `A2A-Version: 1.0`. Task-not-found for GetTask/CancelTask is expected because
   this agent returns direct search messages.
4. If WebMCP is unavailable, check browser API support. If registration fails,
   retry after settings/database recovery; do not interpret a saved toggle as
   proof of registration.
5. Use the Home Assistant integration guide for services and Assist tools; no
   second MCP endpoint is registered by the custom component.

See [backend operation results](backend-operation-results.md),
[operations runbook](operations-runbook.md), and
[Home Assistant integration](home-assistant-integration.md).
