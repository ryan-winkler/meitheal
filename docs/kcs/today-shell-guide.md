---
type: "Guide"
title: "Today Shell Guide"
description: "Understand the Today view and its task controls."
---

# Today Shell Guide

## Today overview

Today starts with the date, task counts and quick capture. The completion indicator exposes its value to assistive technology.

The shared navigation provides:

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
- `#today-flow`

These anchors stay on the same route, which keeps the page ingress-safe in Home Assistant and companion-safe when reopened from the webview.

## Common Jobs

### Jump to the part of Today you need

1. Open `Today`.
2. Use the shell links to jump between Overview, Focus, Triage, Work, Habits, and Flow. The bar marks the current section.
3. Use the title switcher on smaller screens when some links collapse.

### Capture work without leaving Today

1. Use the shell `New Task` button when you need the full modal. The title receives focus when the dialog opens. Tab and Shift+Tab stay inside the dialog, and Escape returns focus to the control that opened it. After a successful save, Details opens on the same page with the new task.
2. Use the inline quick-add field in `Overview` when you want the fastest path.
3. Add a date or shopping list when needed, such as “call dentist tomorrow” or “shopping: milk, eggs”.
4. Stay on the same route so the current Today context is preserved.

### Triage overdue work without losing the daily view

1. Jump to `Triage`.
2. Review carried-forward tasks first.
3. Move back to `Work` or `Focus` with the shell tabs instead of reloading another route.

### Read the daily counters

**Due Today** and **Carried Fwd** reflect their respective sections. **Remaining** includes both sections and shared favorites. **Completed** counts tasks marked complete and updated on the current UTC date, including older records with ISO timestamps. Open **Pinned tasks** from the sidebar to see your personal pins.

While Today is open, the counters and progress bar refresh every 30 seconds. The refresh reads aggregate counts across the full task store. Reload the page to refresh the task rows after an external change.

### Browse a large unscheduled queue

The collapsed queue counts tasks without loading their full rows. The counts and visible Today sections use the same database snapshot.

1. In **Work**, select the **Unscheduled** heading or focus it and press Enter. Today shows the full queue count and loads up to 50 task rows. A task created by a Home Assistant automation without a due date appears here.
2. Use **Next** and **Previous** to reach the rest of the queue. In **Focus**, search the full queue or use **Filter by status**, **Filter by priority**, **Filter by RICE score**, and **Sort tasks**. The count above the rows shows the matching range. Reload keeps the open page and filters.
3. To change a card's manual board position, open the board in **Tasks**. Unscheduled pages use the selected sort order.
4. If a page fails to load, use **Retry** in the section. The last loaded page stays visible while you retry.

## Troubleshooting

### The Today tabs do not move the page

1. Confirm the URL hash changes to one of the Today shell anchors.
2. Refresh once to rule out a stale client boot.
3. If the hash changes but the page does not move, capture the browser console for the shell logger output.

### Clicking a task does not open task detail

1. Confirm the task detail overlay exists in the DOM.
2. Try a second click after the page is fully loaded; the shared detail modal may still be booting.
3. If it still fails, capture any `[Meitheal][tasks/detail-handoff]` warnings from the browser console.

### Counters are slow to reflect a change

Wait for the next 30-second refresh or reload Today. If the counts stay stale, check the browser's Network panel for `GET /api/tasks/today-counts`. An HTTP 503 means the counts are temporarily unavailable. Today keeps the last values and retries on the next interval.
