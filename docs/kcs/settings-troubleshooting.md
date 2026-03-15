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

## Common Jobs

### Find a setting quickly

1. Open `Settings`.
2. Use the search field at the top of the page.
3. Press `Enter` to jump directly to the best match.

The search now prefers direct field hits such as `Theme` over broad section matches.

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

If the theme still resets:

- Check that `/api/settings` writes are not failing in the browser network panel.
- Check whether local storage is being cleared by privacy tooling.

### App & PWA shows `HTTP only`

This means the current origin is not a secure context. Service workers and install prompts require HTTPS or localhost.

Recommended paths:

- Nabu Casa
- DuckDNS + Let's Encrypt
- Reverse proxy with TLS

## HEART Acceptance Lens

- Happiness: the summary cards should make system state understandable at a glance.
- Engagement: shell nav should remove the need to hunt through tabs.
- Adoption: companion and PWA actions should be discoverable in `App & PWA`.
- Retention: theme and settings state should survive reloads and hash deep-links.
- Task Success: all cross-links should land on real section ids.
