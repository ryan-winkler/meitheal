# Meitheal Agent Protocols

Meitheal exposes several agent-facing surfaces, but they are not all the same thing and they do not all expose the same tool set.

This document separates them so the public story stays accurate.

## Current Protocol Surface

| Surface | Status | Notes |
|--------|--------|-------|
| Astro MCP | Live | `POST /api/mcp`, 18 tools in the Astro app |
| Home Assistant MCP | Live | 16-tool MCP surface exposed by the HA custom component |
| Home Assistant LLM API | Live | `Meitheal Tasks`, 21 tools for HA conversation agents |
| A2A | Live, lightweight | Dynamic agent card plus message/task routes |
| WebMCP | Experimental | Product direction documented, runtime registration not currently active in stable browsers |

## Discovery Endpoints

| Endpoint | Purpose |
|---------|---------|
| `/.well-known/agent-card.json` | Static A2A agent card fallback |
| `/api/a2a/agent-card` | Dynamic A2A agent card shaped by current configuration |
| `/.well-known/mcp.json` | MCP discovery manifest |
| `/.well-known/jsondoc.json` | OpenAPI/JSON documentation |
| `/llms.txt` | LLM-readable product summary |

## A2A

Meitheal acts as an A2A server using HTTP+JSON.

### Dynamic skills

The agent card includes core skills such as task management, task search, framework scoring, data export, areas, labels, today summary, habits, and weekly review. When Home Assistant is configured, HA-specific skills such as calendar sync and entity-state access are added dynamically.

### Routes

```text
GET  /api/a2a/agent-card
POST /api/a2a/message
GET  /api/a2a/tasks/{id}
POST /api/a2a/tasks/{id}:cancel
```

### Important limitation

The A2A routes are currently protocol-compliant scaffolding, not a full long-running task engine. The message route is live, but task-status and cancel routes currently return lightweight task stubs rather than persisted background execution state.

## Astro MCP

The Astro app exposes 18 tools at `POST /api/mcp`:

- `createTask`
- `searchTasks`
- `completeTask`
- `updateTask`
- `deleteTask`
- `getTask`
- `getCalendarEvents`
- `getUpcoming`
- `syncCalendar`
- `getOverdueTasks`
- `getTodaysTasks`
- `getTaskSummary`
- `batchComplete`
- `assignTask`
- `listUsers`
- `linkTask`
- `unlinkTask`
- `getTaskLinks`

This is the richest browser/app-side MCP surface and includes user assignment plus manual calendar sync.

## Home Assistant MCP

The bundled Home Assistant custom component exposes a separate 16-tool MCP surface for HA-native agent access:

- `createTask`
- `searchTasks`
- `completeTask`
- `updateTask`
- `deleteTask`
- `getTask`
- `getOverdueTasks`
- `getTodaysTasks`
- `getTaskSummary`
- `dailyBriefing`
- `getCalendarEvents`
- `getUpcoming`
- `batchComplete`
- `linkTask`
- `unlinkTask`
- `getTaskLinks`

It intentionally overlaps with Astro MCP, but it is not identical.

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

## WebMCP

WebMCP remains an experimental product direction. The repo documents the intended browser-agent story, but runtime browser registration is not currently active in stable browsers.

Treat WebMCP as a documented forward path, not a currently shipped mainstream capability.

## Settings

Agent protocol settings live in **Settings → Agent Protocols** in Meitheal.

Use that section to understand which surfaces are enabled and what discovery manifests are active.

## Design Rules

1. Meitheal is HA-first and local-first.
2. Capability counts are surface-specific.
3. Dynamic A2A skills depend on configured integrations.
4. Experimental WebMCP should be described honestly as experimental.
5. Protocol docs should stay synchronized with `llms.txt`, `llms-full.txt`, and the custom-component docs.
