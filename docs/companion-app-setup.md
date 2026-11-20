---
type: "Guide"
title: "Companion App Setup"
description: "Set up Meitheal in the Home Assistant companion app."
---

# Companion App Setup

Open Meitheal in the Home Assistant Companion app on Android or iOS. Add shortcuts or set up notifications and voice controls for the jobs you use regularly.

## Prerequisites

- Meitheal Canary installed and running in Home Assistant
- The Companion app signed in to that Home Assistant instance ([Android](https://play.google.com/store/apps/details?id=io.homeassistant.companion.android) / [iOS](https://apps.apple.com/app/home-assistant/id1099568401))

Open Meitheal from the Home Assistant sidebar. Set up the [optional Core integration](kcs/home-assistant-marketplace.md) for Meitheal sensors, voice actions, and scripts that call Meitheal services.

## URL Handler and X-Callback-URL

The redesigned `Settings → App & Companion` section now surfaces companion-safe deep links directly in the UI:

- `Open in Companion` uses Home Assistant's documented URL handler:
  `homeassistant://navigate/api/hassio_ingress/<TOKEN>/settings#app-pwa-settings`
- `Copy x-callback URL` generates the companion x-callback equivalent for Shortcuts and automation flows:
  `homeassistant://x-callback-url/navigate?path=%2Fapi%2Fhassio_ingress%2F<TOKEN>%2Fsettings%23app-pwa-settings`

Use the Settings copy action when possible so you do not have to hand-encode the ingress path or hash.

**Official references:**
- URL handler: <https://companion.home-assistant.io/docs/integrations/url-handler>
- x-callback-url: <https://companion.home-assistant.io/docs/integrations/x-callback-url/>

## Android Setup

### Shortcuts

Create home screen shortcuts to Meitheal:

1. **Settings → Companion App → Manage Shortcuts**
2. Select **Dashboard** type
3. Enter path: `/meitheal`
   - Use the sidebar path from your browser address bar when Meitheal is open, such as `/meitheal` or `/meitheal_canary`
   - Do not use an `/api/hassio_ingress/` address. It needs a session that only the Home Assistant sidebar creates, so a shortcut or notification that opens it directly shows an authorization error.
4. Set label: "Meitheal" (10 chars max)

**Shortcut paths:** add `?meitheal=` and an encoded Meitheal page to open that page inside the sidebar panel.

| Shortcut | Path |
|----------|------|
| Dashboard | `/meitheal` |
| Tasks | `/meitheal?meitheal=%2Ftasks` |
| Today | `/meitheal?meitheal=%2Ftoday` |
| Calendar | `/meitheal?meitheal=%2Fcalendar` |
| Settings | `/meitheal?meitheal=%2Fsettings%23app-pwa-settings` |

### Quick Settings Tile

Add a quick settings tile for common actions:

1. Pull down notification shade → edit tiles
2. Add "Execute Script" tile
3. Select `meitheal_quick_task` or `meitheal_sync_now`

### Actionable Notifications

Set up the optional Core integration so Home Assistant can call `meitheal.complete_task`. Import both blueprints to send the notification and handle its **Complete** action.

1. **Settings → Automations → Blueprints → Import Blueprint**
2. Import [Task Notification with Actions](https://github.com/ryan-winkler/meitheal/blob/dev/integrations/home-assistant/blueprints/meitheal_task_notification.yaml) and [Complete Task from Notification](https://github.com/ryan-winkler/meitheal/blob/dev/integrations/home-assistant/blueprints/meitheal_complete_from_notification.yaml).
3. Create an automation from each blueprint. Choose the same notification device, then set the task event and the Meitheal sidebar path, such as `/meitheal` or `/meitheal_canary`, in the sender.
4. Save and enable both automations. Send a notification for a sample task and check that **Complete** marks it done.

Tapping a notification opens Meitheal inside the Companion app. Notifications for events with a task ID open that ticket and include **View task** and **Complete**. Older automations that stored an `/api/hassio_ingress/` address fall back to `/meitheal`; edit the automation to set `/meitheal_canary` for Canary. Other events, such as a board update, link to the Meitheal dashboard. If an App event is missing, check that its type is enabled in the Canary's event settings.

### Widgets

Use the companion app Entities widget to display Meitheal sensors:
- `sensor.meitheal_active_tasks` — active task count
- `sensor.meitheal_overdue_tasks` — overdue count
- `sensor.meitheal_total_tasks` — total tasks

## iOS Setup

### Siri Shortcuts

After adding companion_actions.yaml to your configuration:

1. Restart Home Assistant
2. Open Companion App → Settings → Actions
3. Pull to refresh — Meitheal actions will appear
4. Available Siri commands:
   - "Hey Siri, Add Task" (via `MEITHEAL_ADD_TASK`)
   - "Hey Siri, Overdue" (via `MEITHEAL_SHOW_OVERDUE`)
   - "Hey Siri, Sync Tasks" (via `MEITHEAL_SYNC`)
   - "Hey Siri, Summary" (via `MEITHEAL_DAILY_SUMMARY`)

### Apple Watch

Actions with `show_in_watch: true` appear on Apple Watch:
- Add Task
- Show Overdue
- Daily Summary

### CarPlay

`MEITHEAL_DAILY_SUMMARY` is enabled for CarPlay.

## Companion Actions Setup

Add the companion actions to your configuration:

```yaml
# In configuration.yaml
homeassistant:
  packages:
    meitheal_companion: !include packages/meitheal_companion.yaml
```

Or copy `companion_actions.yaml` to your HA config directory:

```bash
cp integrations/home-assistant/companion_actions.yaml /config/packages/meitheal_companion.yaml
```

## Available Scripts

These scripts are callable from shortcuts, Siri, widgets, and automations:

| Script | Purpose | Siri Command |
|--------|---------|-------------|
| `script.meitheal_quick_task` | Create a task | "Add Task" |
| `script.meitheal_check_overdue` | Show overdue notification | "Overdue" |
| `script.meitheal_sync_now` | Force data refresh | "Sync Tasks" |
| `script.meitheal_daily_summary` | Push daily summary | "Summary" |

## Blueprints

| Blueprint | Purpose |
|-----------|---------|
| `meitheal_task_notification.yaml` | Actionable notifications on task events |
| `meitheal_quick_add.yaml` | Reply-to-create task from notification |
| `meitheal_complete_from_notification.yaml` | Complete task from notification button |
