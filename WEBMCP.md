# Meitheal automation protocols

Meitheal exposes five separated automation interfaces across four protocol boundaries. Each interface enforces its own authorization and scope rules.

| Interface | How to use it |
| --- | --- |
| App MCP | Send JSON-RPC 2.0 requests to `POST /api/mcp` with a Meitheal bearer token (`mcp:execute` plus tool scopes). Run `tools/list` to inspect permitted tools. |
| Core LLM API | Install the Home Assistant Core integration. Select **Meitheal Tasks** in the Home Assistant conversation agent settings. |
| Core MCP | Send JSON-RPC 2.0 requests to `POST /api/meitheal/mcp` as a verified Home Assistant administrator when the Core integration is loaded. |
| A2A | Read the A2A `1.0` agent card at `GET /api/a2a/agent-card`. Send `SendMessage` to `POST /api/a2a/message` with `a2a:execute` and `search:read` to search active task titles. |
| WebMCP | Enable **WebMCP (Browser Agent)** in **Settings → Automation & AI → Agent Protocols**. Select **Save Agent Protocol Settings** in an administrator browser session. Compatible browsers register `meitheal_search_tasks` and `meitheal_open_tasks`. |

## App MCP

Create a dedicated token in Meitheal Settings as a verified Home Assistant administrator. Grant `mcp:execute` and the scopes required by each tool. Reading tasks requires `tasks:read`. Completing a task by title requires `search:read` and `tasks:write`.

Send `Authorization: Bearer mth_<token>` on each MCP request. Send `server/discover` on MCP `2026-07-28` clients, or send `initialize` on legacy clients (`2025-03-26` to `2025-11-25`). Next, call `tools/list` and `tools/call`. The App serves discovery metadata at `/.well-known/mcp.json` and the OpenAPI contract at `/openapi.yaml`. Clear the MCP toggle in Settings to turn off App MCP. Select **Save Agent Protocol Settings** to apply the change.

## Home Assistant Core

Home Assistant Core calls the Meitheal API over HTTP with the token stored in its integration entry. Core MCP (`POST /api/meitheal/mcp`) and App MCP (`POST /api/mcp`) accept canonical statuses (`backlog`, `pending`, `active`, `complete`) and Home Assistant aliases (`todo`, `in_progress`, `done`). External `mth_*` tokens never access Home Assistant Supervisor endpoints (`/api/ha/*`).

- [API setup and scopes](docs/kcs/agent-automation-guide.md)
- [Core credential enrollment](docs/kcs/home-assistant-core-credentials.md)
- [MCP, WebMCP, and A2A setup](docs/kcs/webmcp-a2a-setup.md)
- [Protocol boundary decision](docs/decisions/0020-agent-protocol-boundaries.md)
