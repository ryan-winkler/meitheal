---
type: "Guide"
title: "Calendar Shell Guide"
description: "Understand the calendar view and its controls."
---

# Calendar Shell Guide

## What Changed

Calendar opens within **Tasks** at `/tasks?view=calendar`. Older `/calendar` and `/tasks#calendar` bookmarks still open that view and keep their query parameters. The **Task views** navigation marks the current view and links to Kanban, Table, Calendar and Timeline. Use Tab to reach each link and Enter to open it with the current filters. The bottom navigation highlights Calendar on mobile.

## Common Jobs

### Move around the month without losing the shell context

1. Use **Previous month**, **Next month** or **Today** above the grid.
2. Open any day in the displayed month to review its events and due tasks.

### Open a day drawer and create follow-up work

1. Select a day in the month grid using a pointer, Enter or Space.
2. Review tasks due on that date and HA events. Task rows show the shared status label and icon.
3. Use `Add Task` to open the shared task modal with the current drawer date prefilled.

### Switch to another task view without dropping filters

1. Apply the filters you want on Calendar.
2. Choose **Table** or **Kanban** from the Tasks view tabs.
3. Confirm the selected filters remain in the URL after the view changes.

## Troubleshooting

### Calendar sync reports incomplete work or stops retrying

Open **Settings → Integrations → Calendar** and check the selected entity and its last sync error. A failed event import or stale-event reconciliation keeps the entity in an error state. Manual sync returns an incomplete result (HTTP 502), including counts for imports already saved; those saved tasks remain available.

Repair the reported Home Assistant or database problem, then use **Sync now** to retry. Manual sync resets that entity's failure backoff and clears its error only after a successful attempt. Background sync pauses after five consecutive failed attempts; each attempt counts once, even when several events fail. A concurrent or export-only sync is skipped rather than reported as a completed import. Disabling and re-enabling sync also starts a fresh entity session.

### The drawer opens but tasks or events stay empty

1. Confirm the day drawer title updates to the selected date.
2. Check `GET /api/tasks?due_date=YYYY-MM-DD`. The date must exist on the calendar. The response filters before pagination, and `total` counts tasks due on that date. An ISO timestamp matches the date written in the stored value.
3. When a task status looks wrong, compare the list result with the status sent on creation. Known aliases such as `done` become the built-in status `complete`. Custom statuses keep their names. A list filtered by either alias or built-in status includes older rows saved with the alias.
4. If HA events are missing, inspect Home Assistant calendar entity settings and the browser console for `calendar-shell` warnings.

### View switching loses the current filters

1. Confirm the target view-pill link contains the expected query string before clicking it.
2. If the query string disappears after navigation, record the source route, target route, and active filters.
