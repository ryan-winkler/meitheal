# Meitheal Home Assistant Custom Component

The Meitheal custom component makes the add-on feel native inside Home Assistant. It exposes Meitheal tasks as HA entities and services, registers Assist intent handlers, and adds agent tools through the Home Assistant LLM API when available.

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

- Assist intent handlers for core task flows, with optional sentence installation below
- `Meitheal Tasks` Home Assistant LLM API with 21 tools
- Native Meitheal MCP endpoint at the add-on URL `/api/mcp`
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

## MCP access

Use Meitheal's existing Astro MCP endpoint, `POST <add-on-url>/api/mcp`, with
its configured authentication and protocol settings. The HA custom component
does not register an additional MCP server. Its conversation-agent tools use
the Home Assistant LLM API described above.

## Optional custom Assist sentences

Home Assistant loads custom sentence YAML from its configuration directory,
not from an integration's package directory. To enable the supplied English or
Irish phrases, copy `custom_sentences/<language>/meitheal.yaml` from this
component to `<ha_config>/custom_sentences/<language>/meitheal.yaml`, preserving
any existing custom file. Reload the Conversation integration or restart HA,
then test a phrase in **Settings → Voice assistants → Assist**.

The bundled YAML defines an `item` wildcard for task titles. Intent handlers
are registered by this component; the sentence file enables matching for the
default conversation agent. LLM agents use the separately selected Meitheal
Tasks API. See the [HA custom sentences guide](https://www.home-assistant.io/voice_control/custom_sentences_yaml/).

## Assist and automations

- The component can auto-expose `todo.meitheal_tasks` to conversation agents
- With custom sentences installed, registered intent handlers support task creation, completion, overdue checks, today summaries, and related flows
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

## Data and failure behavior

The component reads every task page in the persisted board order. Native
`pending`, `active`, and `complete` statuses are translated into its established
`todo`, `in_progress`, and `done` tool vocabulary. Labels and calendar sync
metadata are decoded at that boundary.

Creation accepts description, priority, ISO due date, urgency, and importance;
HA todo creation preserves the item's due date and description. Reordering uses
the native bulk ordering endpoint. Title-based completion or deletion requires
one exact, case-insensitive title match; use a task ID for duplicate titles.

The streak and completed-today sensors use `/api/gamification`. When that
feature is disabled or its request fails, those sensors are unavailable while
the task list remains available. They never substitute zero for missing stats.
NFC completion requires a task's `nfc_tag_id` to be assigned through the task
API before calling `meitheal.complete_task_by_tag`.
