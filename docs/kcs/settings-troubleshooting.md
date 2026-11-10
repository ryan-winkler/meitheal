---
type: "Runbook"
title: "Settings Shell Troubleshooting"
description: "Find settings and diagnose navigation problems."
---

# Settings Shell Troubleshooting

## What Changed

Settings now uses a grouped shell instead of hidden tabs. The top-level groups are:

- Personal
- Workflow
- Integrations
- Automation & AI
- App & PWA
- Danger Zone

All navigation is hash-based so it stays inside Home Assistant ingress, companion webviews, and the PWA scope.

Save notifications use the selected theme's text and card colors. A colored edge distinguishes the result, and the message stays readable from the moment it appears.

## Administrator access

Manage integration credentials, outbound integration tests, Node-RED deployment, custom CSS and factory reset through a verified Home Assistant administrator session. For standalone development, open the app on the machine running it using the loopback address. A Meitheal HTTP 403 can indicate either a regular user session or an installed Supervisor without the required trusted identity headers. Settings stays open so you can read the error and keep any work in progress. An expired Supervisor ingress session may reload to recover its connection.

Settings downloads exclude credential values. Settings imports also skip credential fields in older files. After an import, re-enter integration secrets separately in Settings. A masked value in Settings means the existing value is kept if the mask is submitted unchanged.

## Common Jobs

### Find a setting quickly

1. Open `Settings`.
2. Open search in the top bar. The search dialog starts with the Settings scope selected.
3. Enter a setting name and choose a result. Use the arrow keys and Enter to open it from the keyboard.
4. Press Escape to close search and return focus to the launcher.

The search now prefers direct field hits such as `Theme` over broad section matches.

### Move between sections

On desktop, use the quick navigation in the top bar. Open the Settings title picker to reach every section, including links that do not fit in the bar. Use the arrow keys and Enter to choose a section. Press Escape to return focus to the title, or scroll the page to close the picker.

On mobile, use the horizontal quick-jump strip near the top. Tap the target section card to jump there without leaving Settings. The visible links are available with Tab, and the current destination is announced as the current location.

### Open integration settings with the keyboard

In **Settings → Integrations**, Tab to an integration and press Enter or Space to open its settings. Tab then reaches the separate help button and the open panel's controls. Collapsed controls stay out of the tab order. Saved settings can open their panel automatically on load. If an integration appears configured but its settings are unavailable, reload and check whether the card button reports the expanded state.

### Reopen Settings in Home Assistant Companion

1. Go to `Settings → App & PWA`.
2. Use `Open in Companion` for the documented `homeassistant://navigate/...` flow.
3. Use `Copy x-callback URL` when wiring Siri Shortcuts or automation callbacks.

These actions preserve the ingress-safe route and reopen the exact Settings section.

### Webhooks sends me to the wrong place

The Webhooks explainer in Integrations should now route to `Automation & AI`, not a dead tab id. If it does not:

1. Refresh the page once.
2. Re-open `Settings → Integrations`.
3. Click the `Agents & AI` callout link again.

If the URL does not change to `#automation-ai-settings`, capture the browser console and file a bug.

### Theme changes do not seem to persist

1. Go to `Settings → Personal`.
2. Change the theme once and wait for the UI to update.
3. Re-open Settings.

Select **Light** or **Dark** to choose a Meitheal palette. **Auto** follows the light or dark appearance of a same-origin Home Assistant panel when it can read it, then uses the corresponding Meitheal palette. A direct ingress page and a panel with an unavailable appearance follow the device preference. Use **Custom** to import your own Meitheal colors.

An accent chosen in **Personal** stays in this browser. The keyboard focus color comes from the current palette and stays visible even if the accent matches the page background. Use **Reset** beside the color swatches to return to the palette's default accent.

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

- Happiness: the summary cards should make system state understandable at a glance.
- Engagement: shell nav should remove the need to hunt through tabs.
- Adoption: companion and PWA actions should be discoverable in `App & PWA`.
- Retention: theme and settings state should survive reloads and hash deep-links.
- Task Success: all cross-links should land on real section ids.
