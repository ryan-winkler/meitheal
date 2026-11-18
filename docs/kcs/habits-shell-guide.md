---
type: "Guide"
title: "Habits Shell Guide"
description: "Use the Routine library and check in on work from your Boards."
---

# Habits Shell Guide

## Routine library

Open **Progress & Growth → Routines → View Routines**, or use the existing `/habits` bookmark. The page includes:

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

The URL hash updates as you move, so the current section can be reloaded or shared.

### Create or edit a Household Routine

1. Choose **New Routine** in the shell or in the Household library section.
2. Set cadence, priority, description, and optional checklist items.
3. Save the habit to update the underlying routine template.

Editing an existing habit now preserves description and priority instead of flattening them.

### Check in on a named Board Routine

**Routines on your Boards** lists Routines from active named Boards you can read through Home Assistant. The same list appears on Today. Each row shows its Board, daily or weekly frequency and current completion state. Choose **Mark done** when available, or follow the Routine’s name to open its Board. Viewers can read the rows; marking done requires the Board’s create and completion permissions. The list shows up to 100 Routines and offers a message to open a Board when more are available.

Board owners create and edit these Routines under **Boards → Groups**. To bind a Routine to a Project, open that Project’s settings and create the Routine there. Its completed ticket retains the Group and Project. Closing or removing the Project prevents new occurrences. Retrying an already completed occurrence keeps its existing ticket, subject to current Board permissions.

Named Board check-ins use a UTC day or a UTC week starting Monday. A generated ticket keeps that occurrence’s date. If a check-in cannot be confirmed, refresh the list before trying again. Reconnect through Home Assistant when the list disappears after an account or connection change.

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

### The new Routine button does nothing

1. Wait a moment and try again; the page controller may still be initializing on first load.
2. If the library’s **New Routine** action works but the shell action does not, capture the browser console and check for `habits-controller` errors.

### Habits load but edits drop fields

This should no longer happen after the shell rewrite. If description or priority disappear after saving, capture the `/api/habits` response and the browser console so the routine template payload can be inspected.
