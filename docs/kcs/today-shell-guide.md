# Today Shell Guide

## What Changed

The Today cockpit now uses the same mature shell language as Settings, Dashboard, and Habits:

- a sticky `UnifiedBar`
- hash-linked Today sections
- SearchHub launch from the shell
- the shared new-task modal from the shell
- the existing clear-done action kept in the bar action cluster

The Today shell sections are:

- `#today-overview`
- `#today-focus`
- `#today-triage`
- `#today-work`
- `#today-habits`

These anchors stay on the same route, which keeps the page ingress-safe in Home Assistant and companion-safe when reopened from the webview.

## Common Jobs

### Jump to the part of Today you need

1. Open `Today`.
2. Use the shell tabs for fast jumps between overview, focus, triage, work, and habits.
3. Use the title switcher on smaller screens when some tabs collapse.

### Capture work without leaving Today

1. Use the shell `New Task` button when you need the full modal.
2. Use the inline quick-add field in `Overview` when you want the fastest path.
3. Stay on the same route so the current Today context is preserved.

### Triage overdue work without losing the daily view

1. Jump to `Triage`.
2. Review carried-forward tasks first.
3. Move back to `Work` or `Focus` with the shell tabs instead of reloading another route.

## Troubleshooting

### The Today tabs do not move the page

1. Confirm the URL hash changes to one of the Today shell anchors.
2. Refresh once to rule out a stale client boot.
3. If the hash changes but the page does not move, capture the browser console for the shell logger output.

### Clicking a task does not open task detail

1. Confirm the task detail overlay exists in the DOM.
2. Try a second click after the page is fully loaded; the shared detail modal may still be booting.
3. If it still fails, capture any `[Meitheal][tasks/detail-handoff]` warnings from the browser console.
