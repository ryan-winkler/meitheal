# Calendar Shell Guide

## What Changed

Calendar now uses `UnifiedBar` above the existing task-view strip, with the month grid, agenda guidance, and flow links grouped into same-route shell sections.

The Calendar shell sections are:

- `#calendar-overview`
- `#calendar-month`
- `#calendar-agenda`
- `#calendar-flow`

The route-level `TaskViewTabs` remain in place for Calendar, Kanban, Table, and Timeline, and they continue to preserve the current query string when switching views.

## Common Jobs

### Move around the month without losing the shell context

1. Use the shell tabs for section movement.
2. Use the month controls inside `Month` for prev/next/today changes.
3. Keep `Sync` in the shell actions so calendar ingestion remains one tap away.

### Open a day drawer and create follow-up work

1. Click a day cell in the month grid.
2. Review the drawer tasks and HA events.
3. Use `Add Task` to open the shared task modal with the current drawer date prefilled.

### Switch to another task view without dropping filters

1. Apply the filters you want on Calendar.
2. Use `TaskViewTabs` to switch to Table or Kanban.
3. Confirm the query string remains intact after the route change.

## Troubleshooting

### The drawer opens but tasks or events stay empty

1. Confirm the day drawer title updates to the selected date.
2. Check `GET /api/tasks?due_date=YYYY-MM-DD`.
3. If HA events are missing, inspect Home Assistant calendar entity settings and the browser console for `calendar-shell` warnings.

### View switching loses the current filters

1. Confirm the target `TaskViewTabs` link contains the expected query string before clicking it.
2. If the query string disappears after navigation, record the source route, target route, and active filters.
