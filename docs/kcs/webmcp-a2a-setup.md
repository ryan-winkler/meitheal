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

Saving the toggle off makes discovery and the MCP endpoint return HTTP 404 on the next authorized request. Existing tokens keep their scopes when you re-enable MCP. HTTP 401 indicates a missing or invalid token. HTTP 403 indicates a blocked operation or browser origin. See the [API setup guide](agent-automation-guide.md) for credentials and scopes.

The endpoint returns a JSON reply per request. Legacy clients that check for a standalone SSE stream receive HTTP 405 on an authenticated GET.

## Check discovery in Settings

**Settings → Automation & AI → Agent Protocols** checks the installed App's MCP manifest and A2A card. The badge counts available **discovery documents out of two**. It does not count saved switches, browser tools, token-authorized MCP tools or executable A2A skills. WebMCP has its own browser registration status below its switch.

Each discovery link appears only after a successful response with the current public contract. A disabled endpoint is reported separately from a failed or malformed response. MCP discovery still requires a scoped token for tool access. A2A discovery advertises no executable interfaces or skills; message execution remains unavailable.

Use **Check discovery** to retry without saving preferences. Checks use the current browser session and ingress path, bypass cached responses, and stop after eight seconds or page cancellation. Saving protocol settings refreshes these checks even after a partial save, so an unsaved checkbox cannot claim availability. Older probe results cannot overwrite a newer check or a disabled result. The saved preferences and administrator policy are unchanged.

## Experimental protocols

The A2A setting in **Settings → Automation & AI → Agent Protocols** controls the experimental discovery card at `GET /api/a2a/agent-card`, `/.well-known/agent-card.json`, and `/.well-known/agent.json`. The card links to the installed App's OpenAPI contract and lists no executable skills or bindings.

When enabled, `POST /api/a2a/message` returns HTTP 501 and legacy task lookups or cancellation return HTTP 404. When disabled, discovery and authorized A2A requests return HTTP 404. A2A API calls using an agent token still require `a2a:execute`. Browser WebMCP registration is separate from A2A execution.

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
