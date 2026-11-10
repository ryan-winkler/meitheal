---
type: Guide
title: "MCP and A2A setup"
description: "Connect to the scoped App MCP endpoint and identify the status of related protocols."
---

# MCP and A2A setup

## Connect an MCP client

1. Create a dedicated Meitheal token with `mcp:execute` and the scopes for the tools you need.
2. Configure the client to send the token in the `Authorization: Bearer` header on every request to `POST /api/mcp`.
3. Call `initialize` and `tools/list`. The public `/.well-known/mcp.json` manifest identifies the endpoint and credential requirement. The authenticated tool list contains only the tools available to that token. Use the returned input schema when calling a tool.

A 401 response means the token is absent, expired, revoked, or invalid. A 403 response means the token lacks access to the operation. Check the installed App’s discovery manifest and the [API setup guide](agent-automation-guide.md) when configuring a client.

## Experimental protocols

The experimental A2A discovery card is served at `GET /api/a2a/agent-card` and both well-known aliases. It links to the App's OpenAPI contract. The card lists recognised message intents and leaves the interoperable bindings list empty until a conforming implementation is available. `POST /api/a2a/message` and the task routes return sample responses. External calls need `a2a:execute`. Browser WebMCP registration remains experimental.

For the Home Assistant conversation LLM API, see [Core credential enrollment](home-assistant-core-credentials.md).
