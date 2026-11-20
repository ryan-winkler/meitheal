---
type: "Guide"
title: "PWA and offline work"
description: "Install Meitheal and recover pending changes in the correct account and Board."
---

# PWA and offline work

Meitheal caches static assets such as scripts, CSS, fonts and icons. Work pages and APIs require network verification. The static offline fallback contains no personal work.

The existing IndexedDB engine can retain supported task edits and pending operations for the verified account, installation and Board that created them. Switching accounts or Boards does not transfer a queue. Previously unpartitioned legacy browser data stays unclaimed for manual recovery; it is not automatically assigned to the next visitor.

## Pending changes

A pending operation keeps its original Board, actor, placement and retry identity. Reconnect using the same account and Board. Do not create another task just because the response was lost.

Capture receipts require a connection. The App checks the original attempt at `GET /api/tasks?captureReceipt=1`; this is the only receipt lookup route. Receipt checks bypass HTTP and service-worker caches. An offline or denied check leaves the save unconfirmed. Retry the original check when connected.

The service worker removes older cached work pages, APIs and receipts when it takes control. Another application's caches remain untouched. It does not turn a cached response into evidence of current permission.

## Conflicts and access changes

A conflict, revoked permission or switched account does not trigger an automatic last-write-wins retry. Keep the pending change, return to its original context and review the current server state. Losing access hides private content. A healthy reconnect can revalidate eligible retained drafts.

Use **Settings → App & Companion** for install and local-storage controls. Clearing storage affects the current account/Board partition only and refuses to erase pending operations. Export or recover pending work before clearing it.

## What needs a connection

Opening work pages, refreshing task lists, verifying access, checking receipts, Calendar/Todo/Grocy sync and webhook delivery need a connection. Notifications and browser storage also depend on the browser's supported APIs and permissions. Do not interpret an unavailable task list as an empty Board.

The app manifest provides the Meitheal icon and Today, Calendar and Settings shortcuts. The sync indicator distinguishes pending operations, an active upload, confirmed saves and offline state. A confirmed local save and a confirmed server acknowledgement are different states.

## Install and Service Worker updates

Meitheal prompts for PWA installation through `apps/web/src/components/pwa/PwaInstallBanner.astro` (triggered by `beforeinstallprompt` on secure origins) and **Settings → App & Companion**. Behind Home Assistant ingress, `apps/web/public/sw.js` derives its `ingressPath` scope from `self.registration.scope` and precaches `/offline.html`, `/manifest.webmanifest`, and `/icon-192.png`.

Consuming an install prompt immediately clears the shared prompt and hides both install controls while the browser choice is pending. A fresh `beforeinstallprompt` event offers installation again. Only `appinstalled` shows the installed badge; accepting or declining the prompt does not confirm installation.

When an updated Service Worker waits to activate, `#toast-container` shows a persistent update prompt (`#sw-update-btn`), and **Settings → App & Companion** exposes **Update & reload** (`#pwa-update-settings-btn`) and **Force App Update** (`#pwa-force-update-btn`). Clicking any of those controls sets `aria-disabled="true"` and `aria-busy="true"`, announces status via `#sync-announcer` (`announceStatus()`), and clears state on failure or timeout so the user can retry. If activation completes elsewhere (`update-activated`), the persistent toast and idle Settings update prompt clear automatically. See [Toast Notifications Reference](toast-notifications.md) for banner suppression and Top-Layer stacking rules.

## Verification

Test an account switch during an IndexedDB read, a Board switch during capture, offline receipt checks, permission revocation and replay of an unchanged attempt. After building the exact candidate, run the worker cache-policy and offline-context browser suites. A source-worker check does not qualify the minified package or the installed Home Assistant ingress/PWA scope.
