---
name: meitheal-task-management
description: >
  Use Meitheal when work lives inside Home Assistant: household tasks, homelab
  operations, daily planning, routines, projects, goals, calendar-linked work,
  and agent-assisted coordination. Manage tasks through the Astro app, Home
  Assistant services, the HA LLM API, MCP, and A2A surfaces.
license: Apache-2.0
compatibility: >
  Requires a running Meitheal addon instance inside Home Assistant.
  Astro MCP endpoint at /api/mcp, REST API at /api/tasks, dynamic A2A routes
  under /api/a2a, and Home Assistant companion surfaces when the custom
  component is loaded.
metadata:
  author: Coolock-Village
  version: "0.3.0"
  homepage: https://github.com/Coolock-Village/meitheal
allowed-tools:
  - Read files
  - Fetch URLs
---

# Meitheal Task Management Skill

Meitheal (pronounced "meh-hal") is a Home Assistant-native execution hub for
households and homelabs. It connects task capture, daily planning, routines,
calendar sync, Home Assistant entities and services, companion flows, and
agent tooling without requiring a separate cloud service.

## When to Use This Skill

Use this skill when the user:

- Asks to create, update, complete, or delete tasks
- Wants to see what's overdue, due today, or coming up
- Asks for a daily briefing or morning summary
- Mentions their to-do list, task list, or household tasks
- Wants to sync or check calendar events
- Asks "what's on my plate?" or "how am I doing?"

## API Access

### Astro MCP (Preferred in the web app)

Send JSON-RPC 2.0 to `POST /api/mcp`:

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "tools/call",
  "params": {
    "name": "createTask",
    "arguments": { "title": "Buy groceries", "priority": 2 }
  }
}
```

Available Astro MCP tools (18):

- `createTask` — title (required), description, priority (1-5), due_date
- `searchTasks` — query, status (backlog/todo/in_progress/done), priority
- `completeTask` — id or title
- `updateTask` — id (required), title, status, priority, due_date, description
- `deleteTask` — id (required)
- `getTask` — id (required) — returns full details including labels, timestamps
- `getOverdueTasks` — no params — all tasks past due date
- `getTodaysTasks` — no params — today's tasks + overdue
- `getTaskSummary` — no params — counts: total, active, overdue, done
- `dailyBriefing` — no params — greeting, tasks, weather, who's home
- `getCalendarEvents` — days_ahead (default: 7)
- `getUpcoming` — days_ahead (default: 7) — combined tasks + calendar
- `batchComplete` — label, max_priority, or titles array
- `assignTask` — id, assigned_to (HA or custom user)
- `listUsers` — no params — list all available users
- `linkTask` — source_task_id, target_task_id, link_type (related_to/blocked_by/blocks/duplicates/duplicated_by)
- `unlinkTask` — task_id, link_id
- `getTaskLinks` — task_id — get outbound + inbound relationships

### Home Assistant LLM API

When the custom component is installed on HA 2026.3+, the `Meitheal Tasks`
LLM API exposes 21 tools to conversation agents, including task CRUD, calendar
events, daily briefing, link management, area/goal listing, move-to-project,
goal progress updates, and remove-from-todo-list actions.

### Home Assistant MCP

The bundled Home Assistant custom component also exposes a separate MCP surface
with 16 tools. It overlaps with Astro MCP, but the tool set is not identical.
Do not assume one global MCP count across all Meitheal surfaces.

### REST API (Alternative)

- `GET /api/tasks` — list all tasks
- `POST /api/tasks/create` — `{ title, frameworkPayload: { description } }`
- `PUT /api/tasks/:id` — `{ status, priority, due_date, description }`
- `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/links` — get task links (outbound + inbound)
- `POST /api/tasks/:id/links` — `{ target_task_id, link_type }`
- `DELETE /api/tasks/:id/links?link_id=xxx` — remove a link

### Discovery

- `GET /.well-known/mcp.json` — MCP server discovery
- `GET /.well-known/agent-card.json` — static A2A agent card fallback
- `GET /api/a2a/agent-card` — dynamic A2A agent card
- `POST /api/a2a/message` — A2A message ingress
- `GET /api/a2a/tasks/{id}` — A2A task status stub

## Domain Language

- Canonical hierarchy: `Area → Goal → Project → Task → Routine`
- Compatibility note: some current UI, imports, and integrations still expose
  legacy board, `task_type`, or Epic/Story language
- For Home Assistant and public docs, treat the newer hierarchy as canonical
  and legacy terms as compatibility surfaces

## Task Data Model

```yaml
id: UUID string
title: string
status: backlog | todo | in_progress | done | cancelled
priority: 1 (urgent) to 5 (lowest), default 3
description: string or null
due_date: ISO 8601 date or null
labels: string array
custom_fields: object (typed — text, number, url, date, select, checkbox)
links: outbound + inbound (related_to, blocked_by, blocks, duplicates, duplicated_by)
```

## Important Notes

- Priority 1 = urgent/highest, 5 = lowest. Default is 3 (medium).
- Status flow depends on the called surface. Use the exact status vocabulary
  expected by that API or tool surface.
- When completing by title, the match is case-insensitive exact match.
- `batchComplete` requires at least one filter (label, max_priority, or titles) — won't complete everything without a filter.
- Authentication is handled by HA Supervisor ingress. No separate auth needed when accessed through HA.
