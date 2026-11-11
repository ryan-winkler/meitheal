---
type: "Guide"
title: "Habits Shell Guide"
description: "Understand the habit view and cadence controls."
---

# Habits Shell Guide

## What Changed

The habits page now uses the same mature shell language as Settings and Dashboard:

- a sticky `UnifiedBar`
- a title switcher with all habits sections
- hash-based section deep links
- SearchHub launch from the shell
- a persistent `New Habit` action in the shell

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

### Create or edit a habit

1. Click `New Habit` in the shell or library section.
2. Set cadence, priority, description, and optional checklist items.
3. Save the habit to update the underlying routine template.

Editing an existing habit now preserves description and priority instead of flattening them.

### Open search from the habits shell

1. Click the search launcher in the shell.
2. Or press `/`, `Cmd+K`, or `Ctrl+K`.
3. Use SearchHub scopes if you want to narrow from `All` to tasks, views, settings, or actions.

The habits shell does not have its own local search implementation. It always hands off to SearchHub.

### Understand how habits flow into the rest of the app

1. Go to `Cross-page Flow`.
2. Follow the quick links into Today, Kanban, Table, or Upcoming.
3. Remember that completing a habit still creates or completes a real task in the shared task model.

When you choose Gaeilge in Settings, the last completion label and date use Irish. The date stays on the stored routine day after a completion or reload, even when your browser is in a different time zone.

## Troubleshooting

### The shell tabs do not move the page

1. Confirm the URL hash changes to one of the habits section ids.
2. Refresh the page once.
3. If the hash changes but the section does not move into view, capture the console and report which section id failed.

### The `New Habit` button does nothing

1. Wait a moment and try again; the page controller may still be initializing on first load.
2. If the inline `New Habit` action works but the shell button does not, capture the browser console and check for `habits-controller` errors.

### Habits load but edits drop fields

This should no longer happen after the shell rewrite. If description or priority disappear after saving, capture the `/api/habits` response and the browser console so the routine template payload can be inspected.
