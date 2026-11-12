---
type: Guide
title: "MCP and A2A setup"
description: "Connect to the scoped App MCP endpoint and identify the status of related protocols."
---

# MCP and A2A setup

## Connect an MCP client

1. Check the MCP toggle in **Settings → Automation & AI → Agent Protocols**. MCP starts enabled on installations without a saved preference.
2. Create a dedicated Meitheal token with `mcp:execute` and the scopes for the tools you need.
3. Configure a Streamable HTTP client to send the token in the `Authorization: Bearer` header on every request. The installed App serves the current manifest at `/.well-known/mcp.json`. Open it through Home Assistant for the ingress-prefixed endpoint, or directly when running standalone.
4. Use `server/discover` with a client supporting MCP 2026-07-28, or `initialize` with an older client. Then call `tools/list` and use the returned input schemas. The catalog contains only tools allowed by the token.

To hand tasks to the client as an assignee, link its token to an agent assignee. See [Hand a task to an AI agent](agent-automation-guide.md#hand-a-task-to-an-ai-agent). Call `whoAmI` first to confirm the identity, then `listMyTasks`.

Claude Code and Codex CLI send a static bearer token. Replace the address with one that reaches your installation over HTTPS, and keep the token in an environment variable:

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

Saving the toggle off makes discovery and the MCP endpoint return HTTP 404 on the next authorized request. Existing tokens keep their scopes when you re-enable MCP. HTTP 401 with a `WWW-Authenticate: Bearer` challenge indicates a missing or invalid token. HTTP 403 indicates a blocked operation or browser origin. See the [API setup guide](agent-automation-guide.md) for credentials and scopes.

The endpoint returns a JSON reply per request. Legacy clients that check for a standalone SSE stream receive HTTP 405 on an authenticated GET.

## Connect through Home Assistant

With the Meitheal integration installed, a client that already signs in to Home Assistant can reach Meitheal without an agent token or a second address. Both routes are limited to Home Assistant administrators.

| Route | Use it for |
| --- | --- |
| Home Assistant's **Model Context Protocol Server** integration | Add the integration, then expose **Meitheal Tasks** (read and change tasks) or **Meitheal Tasks (read only)** as its LLM API. Clients that use Home Assistant's OAuth sign-in connect this way. |
| `POST /api/meitheal/mcp` on your Home Assistant address | A JSON-RPC MCP endpoint served by the integration. Send a Home Assistant long-lived access token in the `Authorization: Bearer` header. |

Through Home Assistant the caller is the signed-in administrator, not an agent assignee, so `whoAmI`, `listMyTasks` and `handBackTask` are available only on the App endpoint with an agent token.

## Check discovery in Settings

**Settings → Automation & AI → Agent Protocols** checks the installed App's MCP manifest and A2A card. The badge counts available **discovery documents out of two**. It does not count saved switches, browser tools or token-authorized MCP tools. WebMCP has its own browser registration status below its switch.

Each discovery link appears only after a successful response with the current public contract. A disabled endpoint is reported separately from a failed or malformed response. MCP discovery still requires a scoped token for tool access. The A2A card advertises one JSON-RPC interface and the read-only `task-search` skill.

Use **Check discovery** to retry without saving preferences. Checks use the current browser session and ingress path, bypass cached responses, and stop after eight seconds or page cancellation. Saving protocol settings refreshes these checks even after a partial save, so an unsaved checkbox cannot claim availability. Older probe results cannot overwrite a newer check or a disabled result. The saved preferences and administrator policy are unchanged.

## Experimental protocols

The A2A setting in **Settings → Automation & AI → Agent Protocols** controls the A2A 1.0 agent card at `GET /api/a2a/agent-card`, `/.well-known/agent-card.json`, and `/.well-known/agent.json`. The card gives the absolute `POST /api/a2a/message` URL inside Home Assistant ingress, the Bearer token requirement, the installed App's OpenAPI contract and one skill, `task-search`.

`POST /api/a2a/message` accepts JSON-RPC 2.0 with the `A2A-Version: 1.0` header and a token with both `a2a:execute` and `search:read`. `SendMessage` takes one text part with a search term, or one JSON part such as `{"query":"heating"}`. It returns up to eight active task titles with their task links, as JSON or plain text. Results never include descriptions. A2A creates no tasks: `GetTask` and `CancelTask` return task not found, `ListTasks` returns an empty list, and streaming and push notifications report unsupported operations. The request body limit is 16 KiB.

When A2A is disabled, discovery and authorized A2A requests return HTTP 404. A missing token returns HTTP 401 and a token without both scopes returns HTTP 403. Browser WebMCP registration is separate from A2A.

For the Home Assistant conversation LLM API, see [Core credential enrollment](home-assistant-core-credentials.md).


## Read-only browser tools (experimental)

WebMCP starts **off**. In **Settings → Automation & AI → Agent Protocols**, enable WebMCP and save. The status below the switch reports whether tools are registered, unavailable in this browser, or failed to start. A saved preference alone does not prove browser support. If saving fails, the draft stays editable: retry with the same Save button. A partial protocol save can persist WebMCP even if a later setting fails; its runtime rechecks the saved value rather than trusting the checkbox.

Compatible browsers expose `document.modelContext.registerTool`. Meitheal uses the current registration `AbortSignal` lifecycle; it does not require a legacy `navigator.modelContext` or `unregisterTool` API. Browser experiments, secure-context rules and iframe permission policies may prevent registration, including inside a Home Assistant frame. Meitheal does not change the host's iframe permissions. Ordinary browsers continue to work without WebMCP.

Only these two tools are registered:

- `meitheal_search_tasks`: a title query of 1–160 characters uses the existing `GET /api/search` contract with `scope=tasks`, `task_fields=title`, and `limit=8`. The result contains at most eight titles and ingress-safe links to task details. User-entered titles are marked as untrusted content.
- `meitheal_open_tasks`: opens only the existing Kanban, Table, Calendar or Timeline Tasks view, using the canonical route. It cannot open an arbitrary URL or modify tasks.

Both tools use the current browser session and existing API authorization. The saved preference is read again before every execution; a missing or false value, denied setting read, aborted lifecycle or failed preference read cannot grant access. Settings administration retains its current HA administrator/local-operator policy. No token, extra scope, writable Core LLM tool or A2A execution is added. Agent proposals still use the human **Review** route.

Saving WebMCP off unregisters its tools through the browser's registration signal and revokes previously held callbacks. A delayed Settings bootstrap cannot re-enable tools from its stale snapshot; registration rechecks the current saved preference. Other tabs refresh after the saved-setting notification; every execution also rechecks persistence if a notification is missed. Navigation/lifecycle abort and development HMR retire old registrations and listeners. Cancelling one call leaves the saved capability registered; navigation or disabling the capability revokes every call. Search/network errors return a structured error rather than reporting successful or empty results. If registration fails, check the connection, browser support and frame permissions, then save again to retry.

The current API contract is the [WebMCP Community Group draft of 10 November 2026](https://webmachinelearning.github.io/webmcp/) and [Chrome's imperative API guide](https://developer.chrome.com/docs/ai/webmcp/imperative-api) (checked 11 November 2026). This is experimental browser functionality, not native Home Assistant acceptance.
