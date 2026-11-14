# Meitheal — Home Assistant Documentation

**Meitheal** (`/meh·hal/`) keeps track of the work your home needs — bringing household tasks, recurring routines, multi-step home projects, and Home Assistant automations into one local-first app in your Home Assistant sidebar.

Synced data stays on your own hardware in `/data/meitheal.db` and is included in standard Home Assistant backups. Offline PWA task changes stay in browser storage until they sync and are not included in Home Assistant backups.

## What You Can Track

| Household Need | Example in Meitheal | Home Assistant Connection |
|---|---|---|
| **Sensor-triggered follow-up** | *Close the back door — still open after 21:45 check* | Created via `meitheal.create_task` or webhook when a sensor stays open |
| **Shared daily & weekly routines** | *School morning bags — lunch, books, and PE kit* | Daily or weekly Routine templates with step-by-step checklists |
| **Preventive maintenance** | *Replace kitchen under-sink water filter cartridge* | Due dates synced with Home Assistant calendars and `todo.meitheal_tasks` |
| **Seasonal home projects** | *Winter Boiler and Heating Prep* | Grouped by **Area** and **Project** across **Today**, **Kanban**, **Table**, and **Calendar** |

## 1. Add the Repository & Install

1. In Home Assistant, open **Settings → Apps → Install app** (or **Settings → Add-ons → Add-on Store** on earlier Home Assistant versions).
2. Open the top-right **⋮** menu and select **Repositories**.
3. Add `https://github.com/ryan-winkler/meitheal-ha-addon`.
4. Select **Meitheal** from the store list.
5. Select **Install**, wait for the container image download to complete, and select **Start**.
6. Enable **Show in sidebar** for one-click household access, then select **Open web UI**.

> **Note:** If an existing Meitheal installation is already running on your system from another repository URL, create a Home Assistant backup before switching entries. If Supervisor logs a `401` image download error during a release transition, check [install status (#1)](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) and reload the store.

## 2. Your First 5 Minutes in Meitheal

1. Open **Today** from the sidebar.
2. In the **Add a task for today** box, enter a real job around the house — for example, `Replace kitchen water filter tomorrow` or `Check hallway smoke sensor` — and select **Add**.
3. Open **Tasks** to view your work as a **Kanban** board, **Table**, **Calendar**, or **Timeline**.
4. Press `/` (or `Ctrl/Cmd + K`) from anywhere to open **Search Hub** and jump straight to any task, project, area, or setting.
5. Visit **Settings → Personal** to choose **Dark**, **Light**, or **Auto** theme, pick an accent color, and set your regional date/week preferences.

## 3. Connect Home Assistant Calendars, To-Do & Assist

### Calendar & To-Do Sync

Open **Settings → Integrations** inside Meitheal to:

- Connect Home Assistant calendar entities and choose your sync direction before enabling sync.
- Link Home Assistant to-do lists so household checklists stay aligned across dashboards and mobile cards.

### Home Assistant Custom Integration (Entities, Actions & Assist)

The Meitheal Home Assistant custom integration is installed separately from this Supervisor App (see the [Home Assistant integration setup guide](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-marketplace.md)):

1. Install `custom_components/meitheal` in Home Assistant and restart Core.
2. In **Meitheal → Settings → Automation & AI**, create a scoped API token (`tasks:read` and `tasks:write`, plus `search:read` for `meitheal.search_tasks` and `tasks:delete` if deleting items via `todo.meitheal_tasks`).
3. In Home Assistant, open **Settings → Devices & Services → Add Integration → Meitheal**. Enter your Meitheal host, port, and HTTPS setting, then your scoped token (if Home Assistant auto-discovers the App, select the discovered **Meitheal** card and enter only the token).

Once paired, Home Assistant exposes:

- **Entities exposed**: `todo.meitheal_tasks`, `sensor.meitheal_active_tasks`, `sensor.meitheal_overdue_tasks`, and `sensor.meitheal_total_tasks`.
- **Services available**: `meitheal.create_task`, `meitheal.complete_task`, `meitheal.complete_task_by_tag`, `meitheal.sync_todo`, `meitheal.search_tasks`, `meitheal.get_overdue_tasks`, and `meitheal.notify_overdue`.
- **Assist & Voice**: Expose `todo.meitheal_tasks` under **Settings → Voice assistants → Expose** using your enrolled scoped token.

## 4. Companion App, PWA & Offline Access

- **Home Assistant Companion**: Meitheal runs cleanly inside Home Assistant Ingress on iOS and Android. Copy ingress-safe Companion deep links and `x-callback-url` shortcuts from **Settings → App & PWA**.
- **Installable PWA**: When served over HTTPS, Meitheal can be installed to your home screen or desktop with offline app-shell caching and queued task updates.

## 5. Backups, Exports & Data Ownership

- **Home Assistant Backups**: Meitheal uses `backup: cold` so SQLite writes are cleanly flushed when Home Assistant creates a full or partial backup. Always create a backup before uninstalling or switching between **Meitheal** and **Meitheal Canary**.
- **Open Exports**: Download your tasks and database anytime as **JSON**, **CSV**, or raw **SQLite** from **Settings → App & PWA**. The **SQLite** download appears only for Home Assistant administrators.

## Configuration Options

| Option | Default | Purpose |
|---|---|---|
| `log_level` | `info` | Structured log verbosity (`debug`, `info`, `warn`, `error`) |
| `log_categories` | `auth, tasks, integrations, observability` | Active structured log domains |
| `log_redaction` | `true` | Redacts tokens, secrets, and credentials from logs by default |
| `audit_enabled` | `true` | Records local audit events for task and token actions |
| `loki_url` | `""` | Optional Grafana Loki push endpoint for homelab observability |
| `license_key` | `""` | Optional offline Ed25519 license key (Meitheal runs fully in grace mode without a key) |

## Support & Troubleshooting

- **Health check**: Watchdog monitors `GET /api/health` on internal port `3000`.
- **Issue tracker**: Report bugs or setup questions at [github.com/ryan-winkler/meitheal-ha-addon/issues](https://github.com/ryan-winkler/meitheal-ha-addon/issues) with your Meitheal version and Home Assistant version (remove any private tokens or personal task titles first).
