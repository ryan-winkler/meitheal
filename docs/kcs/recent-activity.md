---
type: Guide
title: "Review recent activity"
description: "See recent task changes across the shared task list."
---

# Review recent activity

Open **Recent activity** from the Meitheal navigation while signed into Home Assistant. The view shows ordinary task additions, edits, closures and reopenings recorded after the update. Publishing a draft appears once as a task addition.

Choose a **Current area** or **Person** and apply the filters. When a task moves, its activity appears in the new area. Deleting a task removes it from the view. Person filters use the current Home Assistant roster that also verifies access to the page. The page shortens unusually long display names. Events without a current person match have a general attribution and remain visible under **Everyone**.

Select a task title to open its details. Use **Older activity** to continue or **Refresh activity** to see new changes.
Open the task's activity history in Details to inspect its individual field changes.

Recent activity requires an active Home Assistant session and a connection. The web app removes saved copies of the activity page when its service worker activates.

When your browser restores the page from history, Recent activity refreshes using the same filters after checking your Home Assistant account.

## Verify a new release

In a disposable App session with two active Home Assistant accounts, create tasks in two areas. Have the second account edit and close one task and the first reopen it. Confirm each action appears once, that the area and person filters work together, and that a moved task appears in its new area. Follow a task link, then go Back and confirm the filters are retained. Repeat after revoking the viewing account while the task is open and confirm Back denies access without displaying the activity or filters.
