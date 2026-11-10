---
type: "Guide"
title: "Table Shell Guide"
description: "Understand the task table and its controls."
---

# Table Shell Guide

## Open the Table view

Open **Tasks** and choose **Table**. Older `/table` bookmarks redirect to `/tasks?view=table#table` and retain their query parameters. The Tasks header contains Search Meitheal, Ask Home Assistant, and New Task.

On narrow screens, swipe sideways over the table to reach more columns. With a keyboard, focus the **Table View** region and press the Left or Right Arrow key. The selection column stays in view while the table scrolls sideways.

## Common Jobs

### Narrow the table before reading rows

1. Enter text in **Filter by text**, or choose **Filter** above the table to add rules.
2. Select **Apply Rules**. The current rules are recorded in the URL and apply after reload.
3. If no rows match, change the filters or use **Clear all active filters** above the table. Clear returns keyboard focus to the text filter.
4. Use **Previous** and **Next** below the table to move through 50 matching rows at a time. Group counts cover all matches. Select-all and bulk actions apply to visible rows on the current page.

### Save a working view

1. Set the filters, grouping, sort and visible columns you want. Use **Labels** for label selection, **Columns** to choose fields and a column header to sort. **Title** is always visible.
2. Open **Presets**, choose **Save Current Filters** and name the view.
3. Apply the preset from **Presets** or find it in Search Meitheal under **Views**. Both open Table with the same filters and columns, even if the receiving browser remembers a different Area.
4. Remove an individual saved filter using its chip, or choose **Clear all active filters**. For a preset with nested rules, use **Clear Rules** before replacing the group with new rules.

### Open task detail from the dense table

1. Select the task key, or focus it and press Enter or Space. You can also click a non-interactive part of the row.
2. Review the task in the shared detail dialog.
3. Close the dialog to return keyboard focus to the task key.

### Edit a title or select a row

1. Focus the row's **Title** field and edit the text. Press **Tab** to leave the field and save, or **Escape** to discard the edit.
2. Select the row's checkbox. The bulk action bar shows how many rows are selected.

The type icon in each row has a text equivalent. Completed rows stay readable and use the status and strikethrough to indicate completion.

## Table query contract

Table reads filters and presentation with `readTableFilterParams`. An explicit `area_id` takes priority over `area` and the legacy `board` query key. An empty Area explicitly shows all Areas. Only a URL that omits Area uses the browser's remembered Area. Presets and Search write the normalized `area` key.

The server applies normalized filters, grouping, and sorting to the complete eligible task set before taking a page. Filter, group, and sort changes reset `tp`. Columns preserve the page and take effect without a network request. An initial link with no explicit filters can reconcile browser preferences once the page loads.

### Table rows could not update

Choose **Retry** to fetch the current filter selection again. The previous results and address remain visible while the refresh fails. A Table refresh uses a unique `tableRefresh` marker, a no-store response, and the active worker's network-only path. The marker stays out of shared links.

## Troubleshooting

### Saved filters are unavailable

If Presets offers **Activate update**, activate the compatible worker and retry. The list needs a fresh network response and stays unavailable offline. When a legacy preset cannot be read, use **Back to presets** and save a new view from the current Table. An unavailable Area leaves the Table empty until you choose a different Area or clear the filters.

The browser and API clients use the canonical `/api/saved-filters` path. Home Assistant requests retain their ingress prefix. Responses are private and no-store. Encoded or trailing path aliases return 404.

### Row clicks stop opening task detail

1. Try the task key. Space toggles a focused row checkbox or types a space in the title editor. Each control keeps focus for its own action.
2. Check for `[Meitheal][tasks/detail-handoff]` warnings in the browser console.

### Switching to Kanban or Calendar drops the current filters

1. Switch using the Tasks view tabs or press **1** for Kanban and **2** for Table when focus is outside an editable field.
2. Confirm the query stays in the URL when the view hash changes. If it disappears, record the source and destination URLs.

### The first Tasks load uses more memory than later loads

Build the production server and compare its memory before and after the first Tasks request. Keep `date-fns` and `date-fns-tz` in Vite's SSR bundle so the build can discard unused date helpers. Check the rendered due dates with the same date format and time zone in both builds.
