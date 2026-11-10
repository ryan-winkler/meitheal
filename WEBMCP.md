# Meitheal agent protocols

## Available surfaces

| Surface | Status | Contract |
| --- | --- | --- |
| Astro MCP | Available | `POST /api/mcp`; tool inventory generated from the current OpenAPI operations |
| Home Assistant LLM API | Available | `Meitheal Tasks` conversation-agent tools through the HA custom component |
| A2A | Available | A2A 1.0 JSON-RPC scoped task-title search; direct messages, no asynchronous tasks |
| WebMCP | Browser dependent | Opt-in task search and task-view navigation using the current browser session |

The Home Assistant component provides services, sensors, todo entities and LLM
API tools. It does not register a second MCP server. Agents use Astro's existing
MCP endpoint rather than a duplicate integration server.

## Discovery and MCP

`GET /.well-known/mcp.json` reports the current endpoint and generated tool count.
Use JSON-RPC `tools/list` at `/api/mcp` for actual names and input schemas.
The MCP setting gates discovery, initialization, listing and execution. Disabled
requests return 404; unreadable configuration returns 503.

Home Assistant ingress sessions use Supervisor authentication. Supplied agent
tokens need `mcp:execute` and the underlying operation's scopes. Standalone
access follows the configured deployment boundary. Discovery does not promise
anonymous access or mandatory bearer authentication in every installation.

Task creation uses `POST /api/tasks`, with first-class `description`, `priority`
and `due_date`. Task responses are flat objects. Completion reports success only
after the underlying task update succeeds. Underlying operation scopes remain enforced for supplied agent tokens.

Other documentation: `/openapi.yaml`, `/.well-known/jsondoc.json`, `/llms.txt`
and `/llms-full.txt`.

## A2A and WebMCP

Agent Card aliases `/.well-known/agent.json`, `/.well-known/agent-card.json` and
`/api/a2a/agent-card` serve identical discovery with ingress-scoped URLs. The
only A2A skill is `task-search`. `POST /api/a2a/message` requires a valid agent
token with `a2a:execute` and `search:read`, plus `A2A-Version: 1.0`. It accepts
JSON-RPC `SendMessage` with one text or JSON query part and returns active task
titles and links in a direct agent message. It does not create or delegate tasks,
retain asynchronous task state, stream, or send push notifications. Unknown
task and cancel requests are explicitly refused.

WebMCP is disabled by default. Supported browsers can register the read-only
`meitheal_search_tasks` and `meitheal_open_tasks` tools. Settings distinguishes
saved preference, missing browser support, registration success and failure.
Disabling removes registered tools from the browser; every invocation checks
the saved preference.
Page lifecycle and HMR cleanup retire previous registrations. Browser tools use
the signed-in session; the A2A token requirement is separate.

See [agent protocol setup](docs/kcs/webmcp-a2a-setup.md) for request examples,
error semantics and troubleshooting.

## Home Assistant LLM API

When the custom component is loaded on HA 2026.3+, `Meitheal Tasks` exposes 21 tools to conversation agents:

- `meitheal_search_tasks`
- `meitheal_get_task`
- `meitheal_create_task`
- `meitheal_complete_task`
- `meitheal_update_task`
- `meitheal_get_overdue`
- `meitheal_get_todays_tasks`
- `meitheal_task_summary`
- `meitheal_get_calendar_events`
- `meitheal_get_upcoming`
- `meitheal_daily_briefing`
- `meitheal_delete_task`
- `meitheal_batch_complete`
- `meitheal_link_task`
- `meitheal_unlink_task`
- `meitheal_get_task_links`
- `meitheal_remove_from_todo_list`
- `meitheal_list_areas`
- `meitheal_list_goals`
- `meitheal_move_task`
- `meitheal_set_goal_progress`

This is the best surface for voice-adjacent and conversational planning flows inside Home Assistant.

## Verification and operation

Follow [agent protocol setup](docs/kcs/webmcp-a2a-setup.md) for protocol checks and
[Home Assistant integration](docs/kcs/home-assistant-integration.md) for HA setup.
A local API or fixture pass does not establish HA ingress or live integration
acceptance; use the required HA devcontainer tier before claiming those results.
