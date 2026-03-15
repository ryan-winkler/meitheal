# Meitheal Home Assistant Custom Component

Python custom component that registers Meitheal as a first-class HA integration.

## What It Does

| Entity / Service                | Type           | Purpose                            |
| ------------------------------- | -------------- | ---------------------------------- |
| `todo.meitheal_tasks`           | TodoListEntity | Meitheal tasks in HA todo dashboard |
| `sensor.meitheal_active_tasks`  | Sensor         | Active task count                  |
| `sensor.meitheal_overdue_tasks` | Sensor         | Overdue task count                 |
| `sensor.meitheal_total_tasks`   | Sensor         | Total task count                   |
| `meitheal.create_task`          | Service        | Create a task                      |
| `meitheal.complete_task`        | Service        | Mark a task done                   |
| `meitheal.sync_todo`            | Service        | Manual data refresh                |
| `meitheal.search_tasks`         | Service        | Search tasks by IDs, text, status, priority, labels, custom fields, and comments |
| `meitheal.get_overdue_tasks`    | Service        | List all overdue tasks             |
| `meitheal.notify_overdue`       | Service        | Push overdue notification to HA    |

All entities are grouped under a single **Meitheal** device (manufacturer: Coolock Village, model: Task Engine).

**Also includes:**

- **Diagnostics:** Download from Settings → Devices & Services → Meitheal → Download Diagnostics
- **Device Triggers:** Automation triggers on task create/complete/delete events
- **Companion App:** Android shortcuts, iOS Siri/Apple Watch/CarPlay integration

### LLM API Tools (Conversation Agents)

When HA 2026.3+ is available, Meitheal registers an LLM API that exposes these tools to all conversation agents (Google AI, OpenAI, Ollama):

| Tool | Description |
| ---- | ----------- |
| `meitheal_search_tasks` | Search by keyword, IDs, labels, custom fields, comments, status, or priority |
| `meitheal_get_task` | Get full task details by ID |
| `meitheal_create_task` | Create a new task |
| `meitheal_complete_task` | Mark a task as done |
| `meitheal_delete_task` | Delete a task |
| `meitheal_update_task` | Update task fields |
| `meitheal_get_overdue` | List overdue tasks |
| `meitheal_get_todays_tasks` | List tasks due today |
| `meitheal_task_summary` | Get counts (active, overdue, total, done) |
| `meitheal_daily_briefing` | Full daily summary with agenda |
| `meitheal_batch_complete` | Mark multiple tasks as done |

## Installation

**Automatic**: The Meitheal addon auto-installs this component on startup.
No manual steps needed — the component is bundled in the Docker image and
copied to `/homeassistant/custom_components/meitheal/` at boot.

**Manual**: Copy this directory to `<ha_config>/custom_components/meitheal/`.

## Setup

### Automatic (recommended)

When the Meitheal addon starts, it registers itself via the HA Supervisor
Discovery API. You'll see a notification in HA:

1. Go to **Settings → Devices & Services**
2. Look for the **"Meitheal Discovered"** notification
3. Click **Configure** → **Submit**

That's it — entities and services are created automatically.

### Manual fallback

If discovery doesn't trigger (e.g. running outside HA OS):

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **"Meitheal"**
3. Enter the hostname (`local_meitheal`) and port (`3000`)
4. Click **Submit**

Legacy installs using `local_meitheal_hub` are auto-detected during setup.

## Architecture

```text
HA Core ←→ custom_components/meitheal ←→ Meitheal addon REST API ←→ SQLite
```

The component is a thin REST proxy. All task storage stays in Meitheal's SQLite.
Data refreshes every 30 seconds via `DataUpdateCoordinator`.

## How Discovery Works

```text
Addon boots → healthcheck passes → POST /discovery to Supervisor
                                          ↓
                            Supervisor triggers config_flow
                                          ↓
                            async_step_hassio() validates connection
                                          ↓
                            User sees "Meitheal Discovered — Submit"
```

The discovery call is idempotent — the Supervisor deduplicates on each boot.

## Voice Assistant Example

"Hey Google, add 'buy milk' to my Meitheal list"
→ Calls `meitheal.create_task` → Task appears in Meitheal

## Automation Example

```yaml
automation:
  - trigger:
      platform: numeric_state
      entity_id: sensor.meitheal_overdue_tasks
      above: 3
    action:
      - service: notify.mobile_app
        data:
          message: "You have {{ states('sensor.meitheal_overdue_tasks') }} overdue tasks!"
```

## Notification System

The addon dispatches notifications through HA services:

| Channel | Service | Trigger |
|---------|---------|---------|
| Sidebar Bell | `persistent_notification.create` | Task assignment, P1 escalation |
| Mobile Push | `notify.mobile_app_*` | Assignment, due-date reminders |
| Calendar Reminder | `calendar.create_event` | Tasks due within configurable window |

**Actionable notifications:** Android/iOS users see "Open Task" and "✅ Mark Done" buttons on mobile push notifications. Marking done fires `MEITHEAL_TASK_DONE_{id}` event → handled by `ha-connection.ts`.

**Auto-dismiss:** All notification tags (urgent, assigned, due) are cleared when a task is completed.

## HA Publishing Checklist Compliance

This component passes both official HA code review checklists:

| Requirement | Status |
|-------------|--------|
| PEP8 style guidelines | ✅ |
| Constants from `homeassistant.const` | ✅ |
| Config flow (no YAML config) | ✅ |
| `hass.data[DOMAIN]` for state | ✅ |
| Event names prefixed with domain | ✅ |
| Entities extend proper base classes | ✅ |
| No I/O in properties | ✅ |
| `has_entity_name` + `translation_key` | ✅ |
| Device grouping via `DeviceInfo` | ✅ |
| HA shared aiohttp session | ✅ |
| Lifecycle cleanup (`async_shutdown`) | ✅ |
| Diagnostics support | ✅ |
| Services with voluptuous schemas | ✅ |

References:

- [Component checklist](https://developers.home-assistant.io/docs/creating_component_code_review)
- [Platform checklist](https://developers.home-assistant.io/docs/creating_platform_code_review)
