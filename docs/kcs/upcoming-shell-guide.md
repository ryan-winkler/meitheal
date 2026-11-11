---
type: "Guide"
title: "Upcoming Shell Guide"
description: "Understand the Upcoming view and its task controls."
---

# Upcoming Shell Guide

## What Changed

Upcoming now uses the mature unified shell with a lifecycle-safe page controller instead of inline page scripts.

The Upcoming shell sections are:

- `#upcoming-overview`
- `#upcoming-next`
- `#upcoming-week`
- `#upcoming-flow`

The page still keeps direct completion, task-detail handoff, and grouped day accordions intact.

## Common Jobs

### Separate the next 48 hours from the rest of the week

1. Open `Upcoming`.
2. Use the shell tabs or quick-jump chips to switch between `Next 48h` and `Week Ahead`.
3. Keep the route stable while scanning the same seven-day window.

### Complete work directly from Upcoming

1. Use the task checkbox in a day group.
2. The item updates in place without leaving the page.
3. The grouped day card remains open so you can continue scanning the same window.

### Hand work off to detail without leaving the shell context

Select the task title or press Enter when the title link has focus. The shared detail panel opens over Upcoming. Closing it returns you to the same list and restores focus to the link after keyboard use. Press Space on the separate checkbox to complete the task. The title also works as a direct task link in a new tab or when scripts are unavailable.

## Troubleshooting

### Accordion groups stop expanding or collapsing

1. Confirm the day header still updates `aria-expanded`.
2. If the header moves but the list does not, inspect for client errors from `upcoming-shell`.

### Clicking a task opens the wrong route

1. Open the title in the current tab and confirm the Upcoming list remains behind the task panel.
2. Close the panel and confirm the URL returns to `/upcoming`. If the list does not return, capture the browser console and note the task id.
