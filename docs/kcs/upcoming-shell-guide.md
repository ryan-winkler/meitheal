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
2. The checkbox waits for confirmation before accepting another activation. If saving fails, it resets and keeps its current focus so you can retry.
3. After confirmation, the row leaves the open day card. Focus within that row moves to a nearby task or to the day heading. Focus elsewhere stays where you moved it.

### Hand work off to detail without leaving the shell context

Select the task title or press Enter when the title link has focus. The shared detail panel opens over Upcoming. Closing it returns you to the same list and restores focus to the link after keyboard use. Press Space on the separate checkbox to complete the task. The title also works as a direct task link in a new tab or when scripts are unavailable.

The title link and completion checkbox each provide at least a 44 × 44 CSS pixel target. At narrow widths, long titles can truncate while keeping the full title available as the link name.

## Troubleshooting

### Accordion groups stop expanding or collapsing

1. Confirm the day header updates `aria-expanded`. The collapsed list is hidden and skips keyboard focus.
2. Expand the day and confirm you can scroll to and open the final task, including on busy days. If the list does not respond, inspect for client errors from `upcoming-shell`.

### Clicking a task opens the wrong route

1. Open the title in the current tab and confirm the Upcoming list remains behind the task panel.
2. Close the panel and confirm the URL returns to `/upcoming`. If the list does not return, capture the browser console and note the task id.
