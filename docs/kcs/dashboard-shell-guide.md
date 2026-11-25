---
type: "Guide"
title: "Dashboard Shell Guide"
description: "Understand the dashboard layout and shortcuts."
---

# Dashboard Shell Guide

## What Changed

The dashboard now uses the same mature shell language as Settings:

- a sticky `UnifiedBar`
- a title switcher with all dashboard sections
- hash-based section deep links
- SearchHub launch from the shell
- the shared new-task modal from the shell

The Dashboard opens with a short heading and linked counts for open, active, completed and overdue tasks. The toolbar is the entry point for sections, search and the task composer.

The dashboard sections are:

- `#dashboard-overview`
- `#dashboard-momentum`
- `#dashboard-capture`
- `#dashboard-open`
- `#dashboard-recent`

These anchors stay on the same route, which keeps them safe for Home Assistant ingress and companion webviews.

## Common Jobs

### Jump to a dashboard section quickly

1. Open the dashboard.
2. Use the section tabs in the bar for common jumps.
3. Use the title dropdown when a tab is clipped or you are on a narrow viewport.

The URL hash updates as you move, so the current section can be reloaded or shared.

### Use the dashboard on mobile

1. Use the bottom navigation `Home` item to return to the dashboard from thumb reach.
2. The closed sidebar stays hidden and non-interactive until opened, so focus does not land on off-screen links.
3. Task sub-views such as Table remain under `Tasks`; the Calendar bottom item deep-links to `/tasks#calendar` so it avoids the legacy redirect route.

### Capture work without leaving the dashboard

1. Go to `Capture`.
2. Use the inline quick-add form for the fastest path.
   The Dashboard quick-add reads the same shorthand as Today: a date such as `tomorrow`, a priority such as `p1` or `!!`, `#labels`, `@assignees`, and `shopping:` or `errand:` lists. A Dashboard task gets no due date unless you type one. `Smart Task Parsing` in Settings controls both forms.
3. Use the `New Task` button in the shell when you need the full modal.

Both paths keep the dashboard context intact.

### Customize the dashboard

Open **Customize dashboard** in the toolbar. Drag a widget by its grip or use
its up and down buttons. Use **Show widget** to add or remove it, choose
**Full** or **Half** width, and set **Keep expanded** or **Keep collapsed**.
Half-width widgets share a row when the Dashboard has room and stack on narrow
screens. Select **Save dashboard** to apply changes or **Cancel** to leave the
current layout. **Restore defaults**, followed by **Save dashboard**, restores
the five widgets and their original order. The standard Dashboard renders without
its customization code. A saved layout or the customization button loads that
code when needed.

The layout is saved in this browser for the current Home Assistant account.
Standalone mode stores it in the current browser profile. Existing tasks and
shared Boards keep their own settings. Section shortcuts follow your visible
widget order. A bookmarked section can reveal a hidden or collapsed widget for
the current visit. Reload with no section hash to see the saved visibility and
collapsed state again.

If all widgets are hidden, **Add widgets** reopens the editor and **Open Tasks**
opens the task list. You can still use the New Task button in the toolbar.

If saving fails because site storage is disabled, allow site storage and try
again. If another tab has saved a newer layout, close the editor and reopen it
to load the current layout.

### Open search from the dashboard shell

1. Click the search launcher in the shell.
2. Or press `/`, `Cmd+K`, or `Ctrl+K`.
3. Use SearchHub scopes if you want to narrow from `All` to tasks, views, settings, or actions.

The dashboard shell does not have its own local search implementation. It always hands off to SearchHub.

### Focus on one person’s queue

1. Go to `Focus Queue`.
2. Use the user filter to narrow the queue.
3. Use the `Kanban →` button to carry that focus into the Kanban route.

If the filter is set to `Unassigned`, the queue shows only unowned work.

## Troubleshooting

### Sidebar labels are hard to read

The pronunciation, Areas heading, and New Area button use the theme’s secondary text color at full opacity. Check them in both light and dark modes when changing sidebar styles. If the labels are dim inside Home Assistant, compare with the standalone theme and check the inherited secondary text color. The home link is named `Meitheal Home` for assistive technology and displays a visual pronunciation guide.

The **No projects** hint uses the theme’s muted text color at full opacity. Indentation and italic text distinguish it from project links.

The dashboard’s 300 ms page-entry fade can lower text contrast while it runs. The full dashboard accessibility scan uses normal motion and checks the rendered page after the fade and font loading complete.

Completed cards use a status label and a struck-through title. Their area names and other text retain full opacity. Area colors still tint the labels, while the theme controls the text color.

### Search opens but results look broken

1. Query `GET /api/search?scope=all`.
2. If it fails, inspect the add-on logs for search or area-repository errors.
3. If the API is healthy but the overlay still looks empty, check the selected SearchHub scope and task-field toggles.

### The shell tabs do not move the page

1. Confirm the URL hash changes to one of the dashboard section ids.
2. Refresh the page once.
3. If the hash changes but the section does not move into view, capture the console and report which section id failed.

### The `New Task` button does nothing

1. Wait a moment and try again; the modal boot script may still be initializing on first load.
2. If the quick-add form works but the shell button does not, capture the browser console and check for `openNewTaskModal` errors.


### Heading or metric values have poor contrast

Use the theme’s primary text on the Dashboard canvas. Metric tiles use the
current card surface and matching text color. Check both explicit theme choices
and system appearance, then check that keyboard focus is visible on the Active
and Overdue links.

Run `E2E_BASE_URL=<isolated-server> pnpm --filter @meitheal/tests test e2e/dashboard-contrast.spec.ts`
against an isolated browser fixture. The desktop regression checks explicit
Light/Dark with opposite system appearance and Auto with both system
appearances. It samples the actual painted background
beneath temporarily hidden glyphs, restores original inline styles, and checks
text using [WCAG contrast thresholds](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
This covers the selected heading and metric text, not every pixel, personalized palette,
responsive state or native Home Assistant appearance bridge.

Focused placeholders, enabled status choices, native widgets and primary-button
contrast also require the shared form/theme checks. A local Dashboard pass does
not establish that an installed App has the same source or loaded assets.

## Overdue counts and due labels

A failed Overdue read leaves the other available counts and links visible. Refresh to retry the unavailable count. Favorites can update while the Focus Queue keeps its last available rows during a failed refresh.

A date-only due date is a calendar day in the timezone from Settings. A task
due today is not overdue. It becomes overdue on the next calendar day. A due
date with a time becomes overdue when that time passes. The Dashboard counter,
the Overdue Kanban filter and the Focus Queue labels ("Due today", "Due
tomorrow", "Overdue by 2 days") use the same rule.

If the counter disagrees with Today, check the timezone in **Settings → Language & Time**.
`e2e/launch-layout-regressions.spec.ts` covers the counter with tasks due
yesterday, today and tomorrow.

## First visit appearance

A browser with no saved theme uses Auto. Auto follows the Home Assistant theme
inside ingress and the system appearance outside it. An explicit Light, Dark or
Custom choice in Settings still takes priority.

## Workspace tour

Open the keyboard menu beside your profile and select **Interactive tour**.
The tour explains the workspace controls available on the current page. Use
**Skip tour**, Escape, or **Finish** to return to the same workspace and
scroll position. You can start the tour again from the keyboard menu.

## Task detail layout

Description appears immediately after the title by default. Select a section
heading to collapse or reopen that section. Use **Save** or **Cancel** in the
Description editor. Closing the inspector or switching tickets saves your
Description draft first. A failed save keeps the current ticket and draft
available for retry.
When you switch to a ticket with no description, **Cancel** returns to that
ticket's empty preview.
Dragging a card to another Type group updates the open Details after the board
saves the change. Unsaved Description text stays in the editor.
Activity Log starts closed and loads
when you open it. If the request fails, use **Retry** in Activity Log.

Select **Focus mode** on desktop to expand the ticket over the app window. The
**Boxed** appearance keeps the ticket centered, and **Fluid** uses the full
window width. Phones open Details as a full-height sheet. The same task and
drafts stay open when the window resizes. **Exit Focus** or **Escape** returns
to the docked inspector or centered dialog for the current window size. Use
**Close detail** to go back to the page you opened the ticket from. In
**Recent Tasks**, focus returns to the card control you used to open Details,
even after a saved status refreshes the card. To verify this with the keyboard, open a recent card with **Edit
task**, change its status, then close Details and check that **Edit task** has
focus again.

When testing new themes, check that the ticket ID stays readable in the toolbar
in both Light and Dark.

Open **Task detail layout** from the ticket toolbar or from **Settings →
Tasks & Boards**. Drag a section by its grip or move it using the arrows. Open
**Fields** next to Properties, Scheduling or Metadata to arrange the fields in
that group. **Reset layout** restores the original order from either entry
point. The inspector builds the editor rows the first time you open **Task
detail layout**. The controls use the page's existing labels and field access,
so opening the editor does not make another request.

The layout applies to all tickets in the current browser storage context.
Another browser profile, a direct app address, or an embedded Home Assistant
session can have its own layout. If the browser blocks storage, the ticket keeps
the previous layout and the editor displays a save error. Allow site storage
and try the move again.

## Docked Task Inspector and Ingress Reload Persistence

At inner widths of `1440px` or wider (including `1920x1080` monitors with the Home Assistant sidebar expanded), opening a task docks `#task-detail-overlay` as a `420px` right workspace pane (`body.has-docked-inspector`) styled via CSS `@container` queries (`container-name: task-inspector`). While docked, `body` scroll stays unlocked, `#task-detail-panel` uses `role="region"` with its own accessible name, and SearchHub plus single-key shortcuts remain active whenever focus is outside editable panel inputs. Below `1440px`, the inspector switches back to a modal dialog (`role="dialog"`, `aria-modal="true"`) without discarding unsaved title, description, or checklist edits.

Inside Home Assistant Supervisor Ingress, `layout-body-controller.ts` and `task-modal-controller.ts` persist the Ingress-stripped internal route (`pathname + search + hash`, including `/tickets/MTH-142` and filtered sub-views) in `ingress-state-persistence.ts`. Reloading the Home Assistant browser tab within 60 seconds restores `prefix + state.path` in `Layout.astro` without double-prefixing the Ingress URL.
