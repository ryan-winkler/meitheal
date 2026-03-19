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

1. Click a task row in a day group.
2. The shared task detail surface opens instead of routing to a page-local detail implementation.
3. Use the shell tabs to move back to `Week Ahead` or `Flow` when needed.

## Troubleshooting

### Accordion groups stop expanding or collapsing

1. Confirm the day header still updates `aria-expanded`.
2. If the header moves but the list does not, inspect for client errors from `upcoming-shell`.

### Clicking a task opens the wrong route

1. Confirm the browser stays on `/upcoming`.
2. If the URL changes away from `/upcoming`, capture the browser console and note the task id that reproduced it.
