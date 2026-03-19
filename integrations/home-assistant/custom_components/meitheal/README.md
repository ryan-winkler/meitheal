# Meitheal Home Assistant Custom Component

The Meitheal custom component makes the add-on feel native inside Home Assistant. It exposes Meitheal tasks as HA entities and services, registers Assist-friendly surfaces, and adds richer agent tooling when the Home Assistant LLM and MCP features are available.

## What It Adds To Home Assistant

### Entities

| Entity | Type | Purpose |
|-------|------|---------|
| `todo.meitheal_tasks` | TodoListEntity | Meitheal task list inside Home Assistant |
| `sensor.meitheal_active_tasks` | Sensor | Active task count |
| `sensor.meitheal_overdue_tasks` | Sensor | Overdue task count |
| `sensor.meitheal_total_tasks` | Sensor | Total task count |

### Services

| Service | Purpose |
|--------|---------|
| `meitheal.create_task` | Create a task |
| `meitheal.complete_task` | Mark a task done |
| `meitheal.sync_todo` | Force a refresh |
| `meitheal.search_tasks` | Search tasks by text and filters |
| `meitheal.get_overdue_tasks` | Return overdue tasks |
| `meitheal.complete_task_by_tag` | Complete a task via NFC or tag-driven flows |
| `meitheal.notify_overdue` | Push an overdue notification through Home Assistant |

### Voice and agent surfaces

- Built-in Assist intents for core task flows
- `Meitheal Tasks` Home Assistant LLM API with 21 tools
- Home Assistant MCP surface with 16 tools
- Companion-friendly exposure of `todo.meitheal_tasks`

## Installation

### Automatic

The Meitheal add-on bundles and installs this component automatically at startup. In the normal add-on flow, you do not need to copy files manually.

### Manual fallback

If you are testing outside the normal add-on packaging flow, copy this directory to:

```text
<ha_config>/custom_components/meitheal/
```

## Setup

### Automatic discovery

1. Start the Meitheal add-on
2. Open **Settings → Devices & Services**
3. Confirm the **Meitheal** discovery flow
4. Submit the configuration

### Manual fallback

1. Open **Settings → Devices & Services → Add Integration**
2. Search for **Meitheal**
3. Enter the host and port if discovery is unavailable

## Architecture

```text
Home Assistant Core ←→ custom_components/meitheal ←→ Meitheal add-on REST/MCP/LLM surfaces ←→ SQLite
```

The component is intentionally thin. It does not move the task database into Home Assistant. Meitheal remains the system of record.

## Home Assistant LLM API

When Home Assistant supports the LLM API surface, `Meitheal Tasks` exposes 21 tools:

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

These tools give conversation agents a much richer planning surface than the basic Assist intents alone.

## Home Assistant MCP Surface

The component also exposes a separate 16-tool MCP surface:

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

This surface overlaps with Astro MCP, but it is not identical.

## Assist and automations

- The component can auto-expose `todo.meitheal_tasks` to conversation agents
- Built-in intents support task creation, completion, overdue checks, today summaries, and related flows
- Automations can use services, sensors, and notification hooks to react to work, reminders, or review states

## Notifications and mobile flows

The Home Assistant integration supports actionable notifications, companion flows, shortcuts, and widgets through the broader Meitheal add-on setup.

## Publishing and quality

This component is meant to stay aligned with Home Assistant publishing expectations:

- config flow instead of YAML configuration
- proper entity and device grouping
- diagnostics support
- typed service schemas
- lifecycle cleanup
- thin integration boundary with the Meitheal add-on as the system of record
