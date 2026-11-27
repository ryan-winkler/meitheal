---
type: Guide
title: "Review recent activity"
description: "See recent task changes across the shared task list."
---

# Review recent activity

Open **Recent activity** from the Meitheal navigation while signed into Home Assistant. The view shows ordinary task additions, edits, closures and reopenings recorded after the update. Publishing a draft appears once as a task addition.

Human actions show the matching Home Assistant member. Authenticated agent-token actions show the verified token name. The token can also report an origin, such as a Home Assistant automation or script, an Assist conversation agent, a webhook or an MCP client. Meitheal shows that origin next to the token name ("Automation "Bedtime" (via token "HA Bridge")"), but the origin is reported by the token holder, not verified by Meitheal. Only issue tokens to callers you trust to report their origin honestly. An origin link opens only the page that matches its kind: `/config/automation/…` for automations, `/config/script/…` for scripts, or `/config/voice-assistants/…` for conversation agents, without a query string. Any kind may instead link to a Meitheal settings page (`/settings…`, such as Agent Tokens at `#agent-tokens-card`). Other targets are dropped, and an origin name cannot contain its own "(via token …)" label. Internal token IDs, unauthenticated `X-Agent-Id` or `X-Meitheal-Origin-*` headers, and spoofed request body actor fields are never trusted or displayed. Activity recorded before this update is credited to a token only for task additions.

Choose a **Current area** or **Person** and apply the filters. Applying or clearing filters keeps the current Board. When a task moves, its activity appears in the new area. Deleting a task removes it from the view. Person filters use the current Home Assistant roster that also verifies access to the page. The page shortens unusually long display names. Events without a current person match have a general attribution and remain visible under **Everyone**.

Each row shows the task, the change and its author, the time, and the task's current area. Select a task title to open its details. Use **Older activity** to continue, **Latest activity** to return, or **Refresh activity** at the top to see new changes.
Open the task's activity history in Details to inspect its individual field changes.

Recent activity requires an active Home Assistant session and a connection. The web app removes saved copies of the activity page when its service worker activates.

When your browser restores the page from history, Recent activity refreshes using the same filters after checking your Home Assistant account.

## Verify a new release

In a disposable App session with two active Home Assistant accounts, create tasks in two areas. Have the second account edit and close one task and the first reopen it. Confirm each action appears once, that the area and person filters work together, and that a moved task appears in its new area. Follow a task link, then go Back and confirm the filters are retained. Repeat after revoking the viewing account while the task is open and confirm Back denies access without displaying the activity or filters.

Check task links and filter controls in both Light and Dark at phone width. Tab from Current area through Person to Apply filters and confirm each control has a visible focus indicator. Verify rows remain still while filtering and that the browser's normal scroll stays available over the feed.
