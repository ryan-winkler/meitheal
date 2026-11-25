---
type: "Guide"
title: "Habits Shell Guide"
description: "Use the Routine library and check in on work from your Boards."
---

# Habits Shell Guide

## Routine library

Open **Progress & Growth → Routines** for the embedded workspace. The standalone Routine library is at `/routines`, and the existing `/habits` bookmark also works. The standalone page includes:

- a sticky `UnifiedBar`
- a title switcher with all habits sections
- hash-based section deep links
- SearchHub launch from the shell
- a **New Routine** action in the shell for Household work

The habits sections are:

- `#habits-overview`
- `#habits-rhythm`
- `#habits-library`
- `#habits-flow`

These anchors stay on the same route, which keeps them safe for Home Assistant ingress and companion webviews.

## Common Jobs

### Jump to a habits section quickly

1. Open the habits page.
2. Use the section tabs for common jumps.
3. Use the title dropdown if a tab is clipped or you are on a narrow viewport.

Opening a section from the toolbar updates the URL hash, so you can reload or share that destination. Long names shorten in the toolbar. The workspace heading and accessible control names retain the full name.

### Create or edit a Household Routine

1. Choose **New Routine** in the shell or in the Household library section.
2. Choose a `1.75px` Tabler sprite icon (legacy stored emoji values map automatically via `mapEntityEmojiToTabler()`), cadence (`daily` or `weekly`), priority, description, and optional checklist items.
3. Save the habit to update the underlying routine template.

To preselect an Area, open that Area's **Routines** section and choose **New Routine**.

Editing an existing routine preserves description and priority. Household Routine listings and check-ins use the configured household timezone (`GET /api/habits` with optional `area_id` and `project_id` filters, App MCP `listHabits`, Core MCP `listRoutines`, LLM `meitheal_list_routines`) and support check-in mutations (`POST /api/habits` with `action: "complete"`, App MCP `createHabit`, Core MCP `completeRoutine`, LLM `meitheal_complete_routine`).

When Household is deleted, its library and shared creation controls are paused. Restore it from **Boards → Deleted Boards** to recover its saved Routines. Routines on active named Boards remain available in the check-in area.

### Check in on a named Board Routine

**Routines on your Boards** lists Routines from active named Boards you can read through Home Assistant. The same list appears on Today. Each row shows its Board, daily or weekly frequency and current completion state. Choose **Mark done** when available, or follow the Routine’s name to open its Board. Viewers can read the rows; marking done requires the Board’s create and completion permissions. The list shows up to 100 Routines and offers a message to open a Board when more are available.

Board owners create and edit these Routines under **Boards → Areas**. To bind a Routine to a Project, open that Project’s settings and create the Routine there. Its completed ticket retains the Area and Project. Closing or removing the Project prevents new occurrences. Retrying an already completed occurrence keeps its existing ticket, subject to current Board permissions.

Household and named Board Routine check-ins and streaks follow your request or configured household timezone (with UTC fallback when no timezone is configured), using the current day or Monday-start week. A generated ticket keeps that occurrence’s date. If a check-in cannot be confirmed, refresh the list before trying again. Reconnect through Home Assistant when the list disappears after an account or connection change.

The Routines feature must be available to your account. Administrators choose its audience under **Settings → Tasks & Boards → Organization features**. Personal names for Routine and Board come from **Navigation & Shortcuts → Labels**.

### Open search from the habits shell

1. Click the search launcher in the shell.
2. Or press `/`, `Cmd+K`, or `Ctrl+K`.
3. Use SearchHub scopes if you want to narrow from `All` to tasks, views, settings, or actions.

The habits shell does not have its own local search implementation. It always hands off to SearchHub.

### Understand how habits flow into the rest of the app

1. Go to **Related views**.
2. Follow the quick links into Today, Kanban, Table, or Upcoming.
3. Remember that completing a habit still creates or completes a real task in the shared task model.

When you choose Gaeilge in Settings, the last completion label and date use Irish. The date stays on the stored routine day after a completion or reload, even when your browser is in a different time zone.

## Troubleshooting

### The shell tabs do not move the page

1. Confirm the URL hash changes to one of the habits section ids.
2. Refresh the page once.
3. If the hash changes but the section does not move into view, capture the console and report which section id failed.

### Routine counts could not load

Refresh to retry the Household Routine read. The workload counts and local creation controls become available after a successful read. The named Board check-in area reports its own availability.
The disabled toolbar creation control offers refresh guidance when a read fails. Restoration guidance appears only after Household is confirmed deleted.

### The new Routine button does nothing

1. Wait a moment and try again; the page controller may still be initializing on first load.
2. If the library’s **New Routine** action works but the shell action does not, capture the browser console and check for `habits-controller` errors.

### Habits load but edits drop fields

If description or priority disappear after saving, capture the `/api/habits` response and browser console to inspect the routine template payload.
