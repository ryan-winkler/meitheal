# Meitheal documentation

Meitheal (say "meh-hal") is a task manager for your home. It runs as an app in Home Assistant. Use it for household tasks, routines, projects and tasks that come from Home Assistant automations.

Meitheal keeps its data in `/data/meitheal.db` on your own hardware. Home Assistant backups include this file.

> **Note:** The PWA keeps offline changes in your browser until they sync. Home Assistant backups do not include these changes until they sync.

## Examples

| Job | Example task | What Home Assistant does |
|---|---|---|
| Sensor follow-up | *Close the back door. It was open at the 21:45 check.* | An automation calls `meitheal.create_task`, or sends a webhook, when the door sensor stays open. |
| Shared routine | *Pack the school bags: lunch, books and PE kit.* | A daily or weekly routine makes the task and its checklist. |
| Maintenance | *Replace the water filter under the kitchen sink.* | The due date syncs with your Home Assistant calendars and with `todo.meitheal_tasks`. |
| Seasonal project | *Get the boiler and heating ready for winter.* | The tasks go into an area and a project. You can see them in **Today**, **Kanban**, **Table** and **Calendar**. |

## 1. Add the repository and install the app

1. In Home Assistant, go to **Settings → Apps → Install app**. On older versions, go to **Settings → Add-ons → Add-on Store**.
2. Open the **⋮** menu in the top-right corner and select **Repositories**.
3. Add `https://github.com/ryan-winkler/meitheal-ha-addon`.
4. Select **Meitheal** in the list.
5. Select **Install**. Wait for the download to complete.
6. Select **Start**.
7. Set **Show in sidebar** to on, then select **Open web UI**.

> **Note:** If you already have Meitheal from a different repository URL, make a Home Assistant backup before you change to this one. If the Supervisor log shows a `401` error for the image download, read [install status (#1)](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) and then reload the store.

## 2. Your first five minutes

1. Open **Today** from the sidebar.
2. In the **Add a task for today** box, type a real job, for example `Replace kitchen water filter tomorrow`. Then select **Add**.
3. Open **Tasks**. Show your tasks as a **Kanban** board, a **Table**, a **Calendar** or a **Timeline**.
4. Press `/` or `Ctrl+K` (`Cmd+K` on a Mac) to open **Search Hub**. Use it to find a task, project, area or setting.
5. Go to **Settings → Look & Feel** to select the **Dark**, **Light** or **Auto** theme and an accent colour. Choose your date format and week start in **Language & Time**.

## 3. Connect calendars, to-do lists and Assist

### Calendar and to-do sync

In Meitheal, go to **Settings → Connected Services**. There you can:

- Connect Home Assistant calendar entities. Select the sync direction before you start the sync.
- Connect Home Assistant to-do lists. Then the same checklists show in Meitheal, on your dashboards and on your phone.

### The Meitheal integration (entities, actions and Assist)

The Meitheal integration is a custom integration. You install it separately from this app. The [integration setup guide](https://github.com/ryan-winkler/meitheal/blob/dev/docs/kcs/home-assistant-marketplace.md) gives all the steps.

1. Install `custom_components/meitheal` in Home Assistant, then restart Home Assistant Core.
2. In Meitheal, go to **Settings → AI & Agent Access** and make an API token. Give it the `tasks:read` and `tasks:write` scopes.
3. If you want to use `meitheal.search_tasks`, also give the token the `search:read` scope.
4. If you want to delete tasks through `todo.meitheal_tasks`, also give the token the `tasks:delete` scope.
5. In Home Assistant, go to **Settings → Devices & Services → Add Integration → Meitheal**.
6. Type the Meitheal host, the port and the HTTPS setting, then type your token. If Home Assistant finds the app by itself, select the **Meitheal** card and type only the token.

After you connect the integration, Home Assistant has these items:

- **Entities**: `todo.meitheal_tasks`, `sensor.meitheal_active_tasks`, `sensor.meitheal_overdue_tasks` and `sensor.meitheal_total_tasks`.
- **Actions**: `meitheal.create_task`, `meitheal.complete_task`, `meitheal.complete_task_by_tag`, `meitheal.sync_todo`, `meitheal.search_tasks`, `meitheal.get_overdue_tasks` and `meitheal.notify_overdue`.
- **Assist**: To use your tasks with voice, go to **Settings → Voice assistants → Expose** and expose `todo.meitheal_tasks`.

## 4. Companion app, PWA and offline use

- **Home Assistant Companion app**: Meitheal works through Ingress in the Companion app on iOS and Android. To get links and `x-callback-url` shortcuts for the Companion app, go to **Settings → App & Companion**.
- **PWA**: If you open Meitheal through HTTPS, you can install it on your home screen or desktop. The PWA opens when you are offline and keeps your task changes until you connect again.

## 5. Backups, exports and your data

- **Home Assistant backups**: Meitheal uses `backup: cold`. Home Assistant stops the app for a short time, so that all database writes are complete before the backup starts. Make a backup before you uninstall Meitheal, and before you change between **Meitheal** and **Meitheal Canary**.
- **Exports**: Go to **Settings → Backups & Reset → Data Portability** to download your data as **JSON**, **CSV** or **SQLite**. Only Home Assistant administrators can download the **SQLite** file.

## Configuration options

| Option | Default | What it does |
|---|---|---|
| `log_level` | `info` | Sets how much the app writes to the log: `debug`, `info`, `warn` or `error`. |
| `log_categories` | `auth, tasks, integrations, observability, ha, calendar, todo, api, security, search` | Sets which parts of the app write `debug` and `info` messages. The app always writes `warn` and `error` messages. |
| `log_redaction` | `true` | Removes tokens, secrets and passwords from the log. |
| `audit_enabled` | `true` | Records task and token changes in a local audit log. |
| `loki_url` | `""` | Optional. Sends the log to a Grafana Loki server at this URL. |
| `license_key` | `""` | Optional. An offline Ed25519 license key. Meitheal has all its functions without a key. |

## Help and troubleshooting

- **Health check**: The watchdog sends `GET /api/health` to internal port `3000`. If the app does not reply, the watchdog restarts it. Look in the **Log** tab for the cause.
- **Problems**: Report bugs and setup problems at [github.com/ryan-winkler/meitheal-ha-addon/issues](https://github.com/ryan-winkler/meitheal-ha-addon/issues). Give your Meitheal version and your Home Assistant version. Before you send logs or screenshots, remove all tokens and personal task names.
