---
type: "Guide"
title: "Search Hub Guide"
description: "Find work, views, and settings."
---

# Search Hub Guide

## Purpose

Meitheal now uses one universal search hub for finding work, navigating views, jumping into settings, and launching Home Assistant-aware actions.

## How To Open It

1. Focus or click the topbar search field.
2. Press `Cmd+K` on macOS or `Ctrl+K` on Windows/Linux.
3. Press `/` when focus is not already inside a text field.

All three entry points open the same overlay.

## Search Scopes

- `All`: mixed results from tasks, views, settings, and actions
- `Tasks`: advanced task search with field controls
- `Views`: navigation targets such as Kanban, Table, Calendar, and saved filters
- `Settings`: section and field deep links powered by the shared settings registry
- `Actions`: quick actions such as creating a task or opening Home Assistant Assist

## Task Search Fields

Task search can match:

- task IDs and ticket keys
- titles
- descriptions
- labels
- custom fields
- comments

Use the field toggles in the hub to narrow matching, then use:

- `Completed` to include completed work
- `Archived` to include archived work
- `Sort` to switch between relevance and recently updated

## Home Assistant Parity

The Home Assistant custom component, LLM API tool, and MCP `searchTasks` tool now reuse the same upgraded task-search backend instead of maintaining a weaker local-only filter path.

That means search parity now covers:

- Meitheal UI search hub
- `meitheal.search_tasks` service
- `meitheal_search_tasks` LLM API tool
- MCP `searchTasks`

## Troubleshooting

1. If the hub opens but task results look incomplete, check the selected task fields and the completed/archive toggles.
2. If view or settings results are missing, switch to the matching scope instead of staying on `Tasks`.
3. If a Home Assistant caller returns fewer results than the UI, confirm it is calling the current add-on version and not a stale cached endpoint.
4. API clients should use the canonical `GET /api/search` path. Use the normal Home Assistant ingress prefix in a browser. Encoded aliases and trailing slashes return 404. Agent tokens need `search:read`. Search responses are marked private and no-store.
