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

## Experimental protocols

The experimental A2A discovery card is served at `GET /api/a2a/agent-card` and both well-known aliases. It links to the App's OpenAPI contract. The card lists recognised message intents and leaves the interoperable bindings list empty until a conforming implementation is available. `POST /api/a2a/message` and the task routes return sample responses. External calls need `a2a:execute`. Browser WebMCP registration remains experimental.

For the Home Assistant conversation LLM API, see [Core credential enrollment](home-assistant-core-credentials.md).
