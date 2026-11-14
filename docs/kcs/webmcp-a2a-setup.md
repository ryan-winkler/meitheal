---
type: Guide
title: "MCP and A2A setup"
description: "Connect to the scoped App MCP endpoint and identify the status of related protocols."
---

# MCP and A2A setup

## Connect an MCP client

New installations enable MCP by default. Managed-ingress deployments require ingress or an `mcp:execute` token to read `/.well-known/mcp.json`.

To hand tasks to the client as an assignee, link its token to an agent assignee under **Acts as** (requires `tasks:read` plus `tasks:write:assigned` or `tasks:write`). Call `whoAmI` first to confirm the identity, then `listMyTasks`. See [Hand a task to an AI agent](agent-automation-guide.md#hand-a-task-to-an-ai-agent).

1. Enable the MCP toggle in **Settings → Automation & AI → Agent Protocols**.
2. Select **Save Agent Protocol Settings**.
3. Create a dedicated Meitheal token with `mcp:execute` and the scopes for each required tool.
4. Configure your Streamable HTTP client to send `Authorization: Bearer mth_<token>` over HTTPS on every request:

```bash
claude mcp add --transport http meitheal https://meitheal.example/api/mcp \
  --header "Authorization: Bearer $MEITHEAL_TOKEN"
```

```toml
# ~/.codex/config.toml
[mcp_servers.meitheal]
url = "https://meitheal.example/api/mcp"
bearer_token_env_var = "MEITHEAL_TOKEN"
```

The Home Assistant App is reachable through ingress and on the internal App network. A client outside Home Assistant needs your own HTTPS reverse proxy or tunnel to the App. Clients that only support OAuth sign-in, such as ChatGPT connectors, cannot connect with a bearer token.

5. Read `/.well-known/mcp.json` to get the active endpoint.
6. Send `server/discover` on MCP `2026-07-28` clients, or send `initialize` on legacy clients (`2025-03-26` to `2025-11-25`).
7. Call `tools/list` to read the authoritative schemas for tools permitted by your token.
8. Validate your arguments against the returned schemas before you call `tools/call`.

When MCP is disabled, `/.well-known/mcp.json` and `POST /api/mcp` return HTTP `404`. Existing tokens keep their scopes when you enable MCP again. HTTP `401` indicates a missing or invalid token. HTTP `403` indicates an unauthorized scope or untrusted browser origin. See the [API setup guide](agent-automation-guide.md) for credentials and scopes.

`POST /api/mcp` returns one JSON response per request. Authenticated `GET` or `HEAD` probes receive HTTP `405` (`Allow: POST`).

## Connect through Home Assistant

With the Meitheal integration installed, a client that already signs in to Home Assistant can reach Meitheal without an agent token or a second address. Both routes are limited to Home Assistant administrators.

| Route | Use it for |
| --- | --- |
| Home Assistant's **Model Context Protocol Server** integration | Add the integration, then expose **Meitheal Tasks** (read and change tasks) or **Meitheal Tasks (read only)** as its LLM API. Clients that use Home Assistant's OAuth sign-in connect this way. |
| `POST /api/meitheal/mcp` on your Home Assistant address | A JSON-RPC MCP endpoint served by the integration. Send a Home Assistant long-lived access token in the `Authorization: Bearer` header. |

Through Home Assistant the caller is the signed-in administrator, not an agent assignee, so `whoAmI`, `listMyTasks` and `handBackTask` are available only on the App endpoint with an agent token.

## Check discovery in Settings

**Settings → Automation & AI → Agent Protocols** probes the MCP manifest and the A2A agent card. The status badge counts available **discovery documents out of two**. It does not count saved toggles, browser tools, or token-scoped MCP tools. WebMCP shows its own browser registration status below its toggle.

Meitheal shows each discovery link only after a valid response matches the current public contract. The UI reports a disabled endpoint separately from a failed or invalid response. Non-administrator household members can check discovery status, while only administrators can change protocol toggles.

Select **Check discovery** to retry without saving preferences. Each check uses the active browser session and ingress path, bypasses caches, and stops after eight seconds or page navigation. Saving protocol settings refreshes discovery checks even after a partial save. Stale probe responses never overwrite newer checks.

## Experimental protocols

The **A2A (Agent-to-Agent)** toggle controls `GET /api/a2a/agent-card`, `/.well-known/agent-card.json`, and `/.well-known/agent.json`. On managed-ingress deployments, callers outside ingress can read these discovery endpoints with an `a2a:execute` token. Each card returns the ingress-aware `POST /api/a2a/message` URL, the Bearer token requirement, the OpenAPI contract URL, and two skills: `task-search` and `assigned-tasks`.

`POST /api/a2a/message` requires JSON-RPC 2.0, `A2A-Version: 1.0`, and a token with both `a2a:execute` and `search:read`. `SendMessage` takes one plain-text search term or one JSON query object such as `{"query":"heating"}` and returns up to eight active task titles with links, without task descriptions. With `tasks:read`, `ListTasks` returns open tasks assigned to the agent assignee linked to the token (filter with `status`, `contextId`, `statusTimestampAfter`, and `includeArtifacts`), and `GetTask` returns one household task by ID or ticket key (`GET /api/a2a/tasks/{id}` returns the same task). `CancelTask` answers `TaskNotCancelable`: finish or hand back a task through MCP or the task API. Without `tasks:read`, `ListTasks`, `GetTask`, and `CancelTask` are denied; when the token has `tasks:read` but no linked agent assignee, `ListTasks` returns an empty list while `GetTask` still returns matching household tasks. Streaming and push operations return unsupported errors, and the maximum request body size is 16 KiB.

When A2A is disabled, discovery and execution endpoints return HTTP `404`. Missing tokens return HTTP `401`, and tokens without required scopes return HTTP `403`. Browser WebMCP registration operates independently from A2A.

For the Home Assistant conversation LLM API, see [Core credential enrollment](home-assistant-core-credentials.md).

## Read-only browser tools (experimental)

WebMCP starts **off** and requires a Home Assistant administrator session (or a local standalone session).

1. Enable **WebMCP (Browser Agent)** in **Settings → Automation & AI → Agent Protocols**.
2. Select **Save Agent Protocol Settings**.

The status line reports whether tools registered, whether the browser lacks support, or whether startup failed. If a save fails, Meitheal keeps your draft selections. Select **Save Agent Protocol Settings** again to retry. The runtime rechecks the persisted setting rather than trusting the checkbox state.

Compatible browsers provide `document.modelContext.registerTool`. Meitheal manages tool lifetime with `AbortSignal` and requires no legacy `navigator.modelContext` or `unregisterTool` API. Browser flags, secure-context rules, or host `iframe` policies can block registration without affecting normal app usage.

Meitheal registers two read-only browser tools:

- `meitheal_search_tasks`: Queries `GET /api/search` for a 1–160 character title with `scope=tasks`, `task_fields=title`, `limit=8`, and `X-Automation-Source: webmcp`. It returns up to eight task titles and ingress-safe task links with `untrustedContentHint: true`.
- `meitheal_open_tasks`: Navigates the current tab to the Kanban, Table, Calendar, or Timeline Tasks view. It never opens external URLs or mutates tasks.

Both tools run under the active administrator browser session. Meitheal reads `agent-protocols-webmcp-enabled` over HTTP before every tool call. Non-administrator sessions, missing values, `false`, aborted reads, or failed reads block execution. WebMCP adds no tokens, extra scopes, writable Core LLM tools, or A2A mutations. Agent proposals still require human approval in `/review`.

Saving WebMCP off aborts the registration signal and revokes active callbacks. Cross-tab storage events refresh registration state. Page navigation and Vite HMR abort previous registrations and listeners cleanly. Search or network failures return a structured error message instead of an empty list.

WebMCP follows the [WebMCP Community Group draft of 10 November 2026](https://webmachinelearning.github.io/webmcp/) and [Chrome's imperative API guide](https://developer.chrome.com/docs/ai/webmcp/imperative-api). Treat WebMCP as experimental browser functionality rather than native Home Assistant integration.
