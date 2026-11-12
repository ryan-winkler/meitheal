# Meitheal automation protocols

Meitheal exposes a scoped MCP endpoint for external clients. The optional Home Assistant Core integration exposes a separate LLM API for Assist.

| Interface | How to use it |
| --- | --- |
| App MCP | Send JSON-RPC to `POST /api/mcp` with a Meitheal bearer token. Run `tools/list` to see which tools the token can call. |
| Core LLM API | Install the Core integration, then select **Meitheal Tasks** in the Home Assistant conversation agent’s LLM API settings. |
| A2A | The A2A 1.0 agent card describes one read-only skill. A token with `a2a:execute` and `search:read` can search active task titles. A2A cannot create or change tasks. |
| WebMCP | Opt in to experimental read-only browser tools in Settings: search task titles and open a Tasks view. A compatible browser is required. |

## App MCP

Create a dedicated token in Meitheal Settings as a verified Home Assistant administrator. Grant `mcp:execute` and the scopes required by each tool. For example, reading a task also requires `tasks:read`. Title-based completion requires `search:read` and `tasks:write`.

Send an `Authorization: Bearer` header on each MCP request. Use `server/discover` with MCP 2026-07-28 or `initialize` with an older client, followed by `tools/list` and `tools/call`. The App serves live discovery metadata at `/.well-known/mcp.json` and its API contract at `/openapi.yaml`. The installed App’s `tools/list` response is authoritative for the caller. Saving the MCP toggle off disables discovery and tool calls.

## Home Assistant Core

Core calls the Meitheal API using the token enrolled in its integration entry. The Python integration contains an MCP adapter for development, while the App MCP endpoint is the published MCP interface.

- [API setup and scopes](docs/kcs/agent-automation-guide.md)
- [Core credential enrollment](docs/kcs/home-assistant-core-credentials.md)
- [A2A task search](docs/kcs/webmcp-a2a-setup.md)
