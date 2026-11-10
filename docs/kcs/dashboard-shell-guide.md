---
type: "Guide"
title: "Dashboard Shell Guide"
description: "Understand the dashboard layout and shortcuts."
---

# Dashboard Shell Guide

## What Changed

The dashboard now uses the same mature shell language as Settings:

- a sticky `UnifiedBar`
- a title switcher with all dashboard sections
- hash-based section deep links
- SearchHub launch from the shell
- the shared new-task modal from the shell

The dashboard sections are:

- `#dashboard-overview`
- `#dashboard-momentum`
- `#dashboard-capture`
- `#dashboard-open`
- `#dashboard-recent`

These anchors stay on the same route, which keeps them safe for Home Assistant ingress and companion webviews.

## Common Jobs

### Jump to a dashboard section quickly

1. Open the dashboard.
2. Use the section tabs in the bar for common jumps.
3. Use the title dropdown when a tab is clipped or you are on a narrow viewport.

The URL hash updates as you move, so the current section can be reloaded or shared.

### Use the dashboard on mobile

1. Use the bottom navigation `Home` item to return to the dashboard from thumb reach.
2. The closed sidebar stays hidden and non-interactive until opened, so focus does not land on off-screen links.
3. Task sub-views such as Table remain under `Tasks`; the Calendar bottom item deep-links to `/tasks#calendar` so it avoids the legacy redirect route.

### Capture work without leaving the dashboard

1. Go to `Capture`.
2. Use the inline quick-add form for the fastest path.
3. Use the `New Task` button in the shell when you need the full modal.

Both paths keep the dashboard context intact.

### Open search from the dashboard shell

1. Click the search launcher in the shell.
2. Or press `/`, `Cmd+K`, or `Ctrl+K`.
3. Use SearchHub scopes if you want to narrow from `All` to tasks, views, settings, or actions.

The dashboard shell does not have its own local search implementation. It always hands off to SearchHub.

### Focus on one person’s queue

1. Go to `Focus Queue`.
2. Use the user filter to narrow the queue.
3. Use the `Kanban →` button to carry that focus into the Kanban route.

If the filter is set to `Unassigned`, the queue shows only unowned work.

## Troubleshooting

### Sidebar labels are hard to read

The pronunciation, Areas heading, and New Area button use the theme’s secondary text color at full opacity. Check them in both light and dark modes when changing sidebar styles. If the labels are dim inside Home Assistant, compare with the standalone theme and check the inherited secondary text color. The home link is named `Meitheal Home` for assistive technology and displays a visual pronunciation guide.

The dashboard’s 300 ms page-entry fade can lower text contrast while it runs. The full dashboard accessibility scan uses normal motion and checks the rendered page after the fade and font loading complete.

Completed cards use a status label and a struck-through title. Their area names and other text retain full opacity. Area colors still tint the labels, while the theme controls the text color.

### Search opens but results look broken

1. Query `GET /api/search?scope=all`.
2. If it fails, inspect the add-on logs for search or area-repository errors.
3. If the API is healthy but the overlay still looks empty, check the selected SearchHub scope and task-field toggles.

### The shell tabs do not move the page

1. Confirm the URL hash changes to one of the dashboard section ids.
2. Refresh the page once.
3. If the hash changes but the section does not move into view, capture the console and report which section id failed.

### The `New Task` button does nothing

1. Wait a moment and try again; the modal boot script may still be initializing on first load.
2. If the quick-add form works but the shell button does not, capture the browser console and check for `openNewTaskModal` errors.
