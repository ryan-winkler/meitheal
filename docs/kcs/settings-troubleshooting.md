---
type: "Runbook"
title: "Settings Shell Troubleshooting"
description: "Find settings and diagnose navigation problems."
---

# Settings Shell Troubleshooting

## Find and open settings

The desktop directory and the **Sections** button on narrow screens open the same seven sections. The selected section appears beside the directory or below the header. Section links keep their hash when bookmarked or opened within Home Assistant. Browser Back and Forward return to previously opened sections.

Use **Search settings** or press `/` outside an input to open the Settings scope in the shared search. Use the arrow keys and Enter to open a result. A field result takes keyboard focus and opens any integration panel that contains it. Press Escape to close search or the section directory.

On a long Settings page, use **Scroll to top** to return to the header and keep the selected section.

### Open integration settings with the keyboard

In **Settings → Integrations**, Tab to an integration and press Enter or Space to open its settings. Tab then reaches the separate help button and the open panel's controls. Collapsed controls stay out of the tab order. Saved settings can open their panel automatically on load. If an integration appears configured but its settings are unavailable, reload and check whether the card button reports the expanded state.

Save notifications use the selected theme's text and card colors. A colored edge distinguishes the result, and the message stays readable from the moment it appears.

## Configure the sidebar

In **Workflow → Sidebar Configuration**, Areas has the same visibility and label controls as the page links. Use **Move up** and **Move down**, or drag the handle on a wide screen, to position the Areas tree. Reordering preserves the labels and custom links you are editing. Each area retains its project collapse control.

Choose **Save Sidebar Config** to save and reload the current Settings section with the updated sidebar. **Reset to Default** restores the default items and ordering after confirmation. Personal Pinned navigation remains available beside Tasks.

The small status dot beside **Settings** reports app and storage health. Hover or use a screen reader to read its status. Home Assistant connectivity is shown separately in **Settings → Integrations → Home Assistant**.

## Check Home Assistant

Open **Settings → Integrations → Home Assistant** and choose **Test Connection** to check the App’s live Supervisor connection. A standalone instance reports **Standalone**. Its Advanced form still saves standalone settings separately.

- **Access denied** means Home Assistant rejected the App’s credentials. Check its Core API access and retry.
- **Disconnected** means there is no live connection. Check the Meitheal App logs in Home Assistant and retry.
- **Check failed** means Meitheal could not read the connection state. Retry to get the latest state.

## Administrator access

Manage integration credentials, outbound integration tests, Node-RED deployment, custom CSS and factory reset through a verified Home Assistant administrator session. For standalone development, open the app on the machine running it using the loopback address. A Meitheal HTTP 403 can indicate either a regular user session or an installed Supervisor without the required trusted identity headers. Settings stays open so you can read the error and keep any work in progress. An expired Supervisor ingress session may reload to recover its connection.

Settings downloads exclude credential values. Settings imports also skip credential fields in older files. After an import, re-enter integration secrets separately in Settings. A masked value in Settings means the existing value is kept if the mask is submitted unchanged.

## Recover from an error

- If Settings cannot load, choose **Try again**. The controls are paused until Meitheal can read the stored values.
- If a Personal preference fails to save, its control returns to the last known value. Check the connection or your permissions and try the change again.
- If a save reports that some changes were saved, its form keeps your entries. Retry the save to finish, or reload Settings to see the stored values. For Calendar and To-do, the save also checks whether the sync service accepted the request.
- The accent picker is a browser preference. Reset in Personal to use the default accent again.

### A household member is missing

**Workflow** uses the same user list for **Users & Assignment** and notification overrides. Adding or removing a custom user refreshes both lists. If Home Assistant users could not load, custom users and their preferences are still available when the local database responds. Check the Home Assistant connection under **Integrations**, then reopen Settings.

### Reopen Settings in Home Assistant Companion

1. Go to `Settings → App & PWA`.
2. Use `Open in Companion` for the documented `homeassistant://navigate/...` flow.
3. Use `Copy x-callback URL` when wiring Siri Shortcuts or automation callbacks.

These actions preserve the ingress-safe route and reopen the exact Settings section.

### Webhooks sends me to the wrong place

The Webhooks callout in Integrations opens **Automation & AI**. If it does not:

1. Refresh the page once.
2. Re-open `Settings → Integrations`.
3. Click the `Agents & AI` callout link again.

If the URL does not change to `#automation-ai-settings`, capture the browser console and file a bug.

### Theme changes do not seem to persist

1. Go to `Settings → Personal`.
2. Change the theme once and wait for the UI to update.
3. Re-open Settings.

Select **Light** or **Dark** to keep that Meitheal palette. **Auto** follows the appearance of a same-origin Home Assistant panel as it changes. A direct ingress page and a panel whose appearance cannot be read follow the device preference. Use **Custom** to import your own Meitheal colors.

An accent chosen in **Personal** stays in this browser. The keyboard focus color comes from the current palette and stays visible even if the accent matches the page background. Use **Reset** beside the color swatches to return to the palette's default accent.

Open **Personal → Customize appearance** to choose a typeface and corner roundness. Use **Save appearance** to apply the choices in this browser. **Reset to defaults** selects the original typeface and corners. Save to apply them.

If the theme still resets:

- Check that `/api/settings` writes are not failing in the browser network panel.
- Check whether local storage is being cleared by privacy tooling.

### The language did not change

Choose English or Gaeilge under **Settings → Personal → Language**. Meitheal reloads the page and sends the dictionary for that language. If the interface still uses the previous language after reload, check whether your browser is accepting the `meitheal-locale` cookie.

### App & PWA shows `HTTP only`

This means the current origin is not a secure context. Service workers and install prompts require HTTPS or localhost.

Recommended paths:

- Nabu Casa
- DuckDNS + Let's Encrypt
- Reverse proxy with TLS

### Check browser and installed app notifications

Open **Settings → App & PWA → Troubleshooting** and choose **Send a test notification**. Allow notifications if prompted. Check this device’s notification center and open the test notification to return to **App & PWA**.

If permission is blocked, allow notifications in the browser’s site settings and try again. If the test cannot send, reload the HTTPS app to give its service worker time to start. Home Assistant Companion alert recipients are configured under **Settings → Workflow → Notifications**.

### Delete old completed tasks

1. Go to `Settings → Danger Zone`.
2. In the **Archiving & Data Retention** card, select a period (3, 6, 12, or 24 months).
3. Click **Preview** to see how many tasks would be deleted.
4. Click **Delete Tasks** and confirm in the dialog.

The deletion cascades to comments, activity logs, and task links. An audit trail entry is created.

> **Tip:** Export your data first via `App & PWA → Export` before deleting.

### Preview shows 0 tasks but I have old completed tasks

This feature uses the `updated_at` timestamp. If a completed task was edited recently (e.g. notes added), its `updated_at` resets and it won't match the age filter. This is by design — it protects recently-touched data.

### What's the difference between Archive and Delete?

- **Archive**: Hides a completed task from default views. Data is preserved. Reversible.
- **Delete**: Permanently removes the task and all related data. Irreversible.

See `docs/kcs/task-lifecycle-glossary.md` for the full ubiquitous language reference.

## HEART Acceptance Lens

- Happiness. Status and save feedback appear beside the controls and after each action.
- Engagement. All sections are reachable from the desktop directory or the narrow-screen Sections button.
- Adoption. companion and PWA actions should be discoverable in `App & PWA`.
- Retention. theme and settings state should survive reloads and hash deep-links.
- Task success. all cross-links should land on real section ids.

## Home Assistant conversation agents

Settings → Automation & AI and Ask Home Assistant require a currently verified
Home Assistant administrator. They discover agents from Home
Assistant's `conversation/agent/list` WebSocket command. HA includes loaded
`conversation.*` entities and agents registered through integration config
entries in this response. No provider list or language filter is applied. A
configured integration without a loaded conversation agent is not runnable and
will not appear until Home Assistant loads it.

Both pickers refresh when opened and offer **Refresh agents**. Keyboard focus stays on Refresh while discovery runs; repeated activation is ignored. Refresh and discovery status use the selected language. Proxy failures with HTML or empty responses show a stable discovery error instead of a JSON parser exception. Discovery bypasses
browser caching. A saved agent ID stays selected if the agent is removed or HA
cannot be reached; it is never silently replaced by the default. An unavailable
agent is labelled in the picker. Ask Home Assistant prevents sending to an agent
confirmed missing by a successful discovery. Select an available agent, or fix
its integration in HA and refresh. A failed discovery displays a retry message
while preserving the last selection. This failure is separate from the app's
own connection to its server. The compact app status beside Settings remains reachable through its accessible description. Operator logs distinguish static `invalid_agent_payload` and `websocket_request_failed` reasons without recording the HA payload.

Ask Home Assistant keeps its chat and HA conversation ID when closed and
reopened on the same page. Changing the selected agent starts a new conversation.
The Settings default is persistent; the most recent Ask selection is stored for
the browser session. Saving a new Settings default clears that session override.

For native qualification, open the managed Canary through HA ingress, confirm
all loaded agents match HA's Assist picker, add or reload an agent in HA, and
refresh both Meitheal pickers. Test a multi-turn exchange, close/reopen, then
change agents. An isolated browser fixture checks the picker behavior but does
not establish Supervisor permissions or HA integration health.

Upstream contract: [HA conversation WebSocket implementation](https://github.com/home-assistant/core/blob/master/homeassistant/components/conversation/http.py)
and [registered-agent manager](https://github.com/home-assistant/core/blob/master/homeassistant/components/conversation/agent_manager.py).

## Verify a Settings change

Run the Astro dev server against a disposable database. Run the Settings, Theme and Search Hub browser specs with `E2E_BASE_URL` pointed to that server. Check compact viewports, both palettes and keyboard focus with integration cards open and closed.

Use the Home Assistant devcontainer to check the ingress page, Companion URL construction in that scope and Calendar or To-do service changes. Use test entities. A loopback ingress proxy is useful for checking URL construction and browser requests. Supervisor behavior and mobile app handoff require their own checks.

## Navigation and daily review

Ticket links retain the background view when changing board pages or using keyboard view shortcuts. Closing a legacy ticket link returns to its source page. Direct ticket URLs select Tasks in the mobile tab bar. On local HTTP, drawer and custom-link IDs use the browser's available cryptographic random source. Project deletion keeps the Home Assistant ingress path.

Today formats its visible and machine-readable dates in the workspace timezone, using the selected language. Evening dismissal and snoozing use the browser's local calendar date; blocked browser storage does not stop the review controls.
