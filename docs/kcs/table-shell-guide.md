---
type: "Guide"
title: "Table Shell Guide"
description: "Understand the task table and its controls."
---

# Table Shell Guide

## Open the Table view

Open **Tasks** and choose **Table**. Older `/table` bookmarks redirect to `/tasks#table` and retain their query parameters. The Tasks header contains Search Meitheal, Ask Home Assistant, and New Task.

On narrow screens, swipe sideways over the table to reach more columns. With a keyboard, focus the **Table View** region and press the Left or Right Arrow key. The selection column stays in view while the table scrolls sideways.

## Common Jobs

### Narrow the table before reading rows

1. Enter text in **Filter by text**, or choose **Filter** above the table to add rules.
2. Select **Apply Rules**. The current rules are recorded in the URL and apply after reload.
3. If no rows match, change the filters or use **Clear all active filters** above the table.

### Open task detail from the dense table

1. Select the task key, or focus it and press Enter or Space. You can also click a non-interactive part of the row.
2. Review the task in the shared detail dialog.
3. Close the dialog to return keyboard focus to the task key.

### Edit a title or select a row

1. Focus the row's **Title** field and edit the text. Press **Tab** to leave the field and save, or **Escape** to discard the edit.
2. Select the row's checkbox. The bulk action bar shows how many rows are selected.

The type icon in each row has a text equivalent. Completed rows stay readable and use the status and strikethrough to indicate completion.

## Troubleshooting

### Row clicks stop opening task detail

1. Try the task key. Space toggles a focused row checkbox or types a space in the title editor. Each control keeps focus for its own action.
2. Check for `[Meitheal][tasks/detail-handoff]` warnings in the browser console.

### Switching to Kanban or Calendar drops the current filters

1. Switch using the Tasks view tabs or press **1** for Kanban and **2** for Table when focus is outside an editable field.
2. Confirm the query stays in the URL when the view hash changes. If it disappears, record the source and destination URLs.

### The first Tasks load uses more memory than later loads

Build the production server and compare its memory before and after the first Tasks request. Keep `date-fns` and `date-fns-tz` in Vite's SSR bundle so the build can discard unused date helpers. Check the rendered due dates with the same date format and time zone in both builds.
