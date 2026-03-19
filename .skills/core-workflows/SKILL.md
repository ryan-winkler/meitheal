---
name: meitheal-core-workflows
description: Core Meitheal workflows for task capture, planning, sync, and agent-assisted execution inside Home Assistant.
version: 1.0.0
---

# Meitheal Core Workflows

Standard operating procedures for Meitheal as a Home Assistant-native execution hub.

## Available Workflows

- **Capture Task** — `POST /api/tasks` or the task modal with title, description, priority, labels, due date, or checklist data
- **Update Task** — `PUT /api/tasks/:id` with title, status, priority, due date, description, project, area, or related metadata depending on the surface
- **Complete or Archive** — use task routes, Today actions, or Home Assistant services depending on context
- **Search Across Work** — `GET /api/search` for universal search, or task-specific search through `/api/tasks` and HA service surfaces
- **Sync Calendars and Todo** — Home Assistant calendar/todo bridges plus manual sync routes and services
- **Daily Briefing** — Home Assistant LLM API or MCP surfaces for a morning summary and today planning
- **Review and Handoff** — Meitheal's current review and agent surfaces where human approval is part of the flow

## Status Flow

Canonical docs now describe work as `Area → Goal → Project → Task → Routine`.
Some live APIs and compatibility layers still expose legacy board or `task_type`
language during the transition. Match the vocabulary of the called surface.

## Priority Scale

| Value | Meaning |
| ----- | ------- |
| 1 | Urgent / Critical |
| 2 | High |
| 3 | Medium (default) |
| 4 | Low |
| 5 | Lowest |

## Integration Points

- Home Assistant services: `meitheal.create_task`, `meitheal.complete_task`, `meitheal.sync_todo`, `meitheal.search_tasks`, `meitheal.get_overdue_tasks`, `meitheal.complete_task_by_tag`, `meitheal.notify_overdue`
- Astro MCP: 18 tools via `/api/mcp`
- HA MCP: 16 tools via the custom component
- HA LLM API: 21 tools through `Meitheal Tasks`
- A2A: dynamic agent card plus `/api/a2a/message`
- Voice: built-in Assist intents plus LLM-backed conversation agent tooling
