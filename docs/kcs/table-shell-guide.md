# Table Shell Guide

## What Changed

Table now uses the unified shell above the existing task-view strip while keeping dense table controls in anchored sections below the shell.

The Table shell sections are:

- `#table-overview`
- `#table-filters`
- `#table-fields`
- `#table-flow`

The shell keeps SearchHub, Assist, and the shared new-task entry point. Filters, saved presets, and column customization stay attached to the data surface instead of moving into the shell.

## Common Jobs

### Narrow the table before reading rows

1. Jump to `Filters`.
2. Use the filter toolbar and saved presets together.
3. Keep the table route stable while iterating on the same dataset.

### Adjust visible columns without leaving the current route

1. Jump to `Fields`.
2. Use the column customizer beside the table.
3. Return to `Overview` or `Flow` with the shell tabs when you are done.

### Open task detail from the dense table

1. Click a non-interactive part of a row.
2. The shared task detail surface opens.
3. Interactive controls like checkboxes, selects, and links still keep their own behavior.

## Troubleshooting

### Row clicks stop opening task detail

1. Confirm you are not clicking a checkbox, button, select, or link in the row.
2. Check for `[Meitheal][tasks/detail-handoff]` warnings in the browser console.

### Switching to Kanban or Calendar drops the current filters

1. Confirm the `TaskViewTabs` link includes the active query string before navigation.
2. If the target route loads without those params, record the exact source URL and target URL.
