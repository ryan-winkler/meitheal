---
type: "Guide"
title: "PWA & Offline-First Guide"
description: "Install the web app and understand offline behavior."
---

# PWA & Offline-First Guide

## How Offline Mode Works

Meitheal uses a **service worker** to cache the app shell and intercept network requests. When you lose connectivity:

1. **Static assets** (CSS, JS, fonts) — served from cache instantly
2. **API routes** — attempted via network, falls back to cached response or offline error
3. **Navigation** — cached pages load normally, unknown routes show the offline fallback page
4. **Task operations** — saved to IndexedDB immediately, queued for sync when online

## What's Available Offline

| Feature | Offline | Notes |
| --------- | --------- | ------- |
| View tasks | ✅ | Last-synced data from IndexedDB |
| Create tasks | ✅ | Saved locally, synced when online |
| Edit tasks | ✅ | Saved locally, synced when online |
| Delete tasks | ✅ | Marked for deletion, synced when online |
| Image attachments | ✅ | Stored as Base64 in IDB `task_attachments` store |
| Notifications | ✅ | Overdue alerts work offline (fired from client) |
| Cross-tab sync | ✅ | BroadcastChannel works entirely client-side |
| Calendar sync | ❌ | Requires network (HA API call) |
| Webhook delivery | ❌ | Requires network |

## Web API Integrations

Meitheal leverages modern browser APIs for a native-like experience:

| API | Module | Purpose |
| ----- | -------- | --------- |
| Notifications + Permissions | `domains/offline/notifications.ts` | Task reminders, overdue alerts |
| Web Locks | `domains/offline/sync-lock.ts` | Single-tab sync queue safety |
| BroadcastChannel | `domains/offline/tab-sync.ts` | Cross-tab state sync |
| Clipboard | `lib/clipboard.ts` | Copy task URL/markdown |
| IntersectionObserver | `lib/lazy-load.ts` | Deferred rendering |
| prefers-color-scheme | `lib/theme-watcher.ts` | OS dark/light detection |
| Badging | `Layout.astro` | Pending task count on app icon |
| Page Visibility | `sync-engine.ts` | Throttle sync when tab hidden |
| StorageManager | `offline-store.ts` | Quota monitoring |

All APIs use **feature detection** with graceful fallbacks — unsupported browsers get silent no-ops.

## Manifest Features

The web app manifest (`manifest.webmanifest`) includes:

- **Install icons** use the Meitheal mark from `apps/web/public/logo.svg` at 192 and 512 pixels. The maskable icon extends the navy background to every edge and keeps the mark within the safe circle.
- **Shortcuts**: Today, Calendar, Settings — appear in long-press/right-click on the app icon
- **Screenshots**: Desktop and mobile captures of Today with sample tasks. The built app serves them from `/pwa/screenshots/`.
- **App & PWA entry point**: Settings now includes companion handoff actions and install troubleshooting in one place

### Sync Status Indicator

| Icon | State | Meaning |
| ------ | ------- | ----------- |
| ✓ | Synced | All changes saved to server |
| ↻ | Syncing | Upload in progress |
| ● | Pending | Changes queued, waiting for connectivity |
| ⊘ | Offline | No network connection |

## Conflict Resolution

When the same task is edited on multiple devices:

- **Last write wins** — the most recent `updatedAt` timestamp takes precedence
- The server's timestamp is authoritative (prevents clock skew issues)
- Conflicts are logged as `sync.conflict.resolved` domain events
- No data is lost — overwritten changes are preserved in the event log

## Storage Limits

- **Sync queue**: max 100 pending operations (warning at capacity)
- **IndexedDB tasks**: warning at 50MB, guidance at 100MB
- **IndexedDB attachments**: large images are Base64-encoded (~1.37x file size); monitor total IDB usage
- **Precache**: ≤ 1MB budget for static assets
- **StorageManager**: quota monitoring logs warnings when usage exceeds 80%

## Troubleshooting

| Problem | Solution |
| --------- | ---------- |
| App shows stale data | Pull down to refresh, or check sync indicator |
| "Queue at capacity" | Connect to network to flush pending changes |
| SW update available | Accept update prompt when it appears |
| Clearing all offline data | Browser settings → Clear site data |
| Force sync | Navigate to any page while online |
| Attachment not showing | Check browser IDB storage quota in DevTools |
| Notification not showing | Check notification permissions in browser settings. App & PWA shows a test notification with the app icon when the browser first grants permission. |
| Theme not matching OS | Clear `meitheal-theme` from localStorage |

## Home Assistant Ingress Compatibility

When Meitheal runs as an HA add-on, all URLs are proxied through `/api/hassio_ingress/{token}/`. PWA scope validation, service worker registration, and manifest resolution all depend on stable URLs — and this works because:

1. **Ingress token is permanent** — per-installation, survives restarts and addon updates (confirmed HA issue #6605)
2. **`Service-Worker-Allowed: /`** — set by middleware, allows SW to claim scope broader than its script path
3. **`X-Ingress-Path`** — available server-side as request header from Supervisor, echoed as response header by middleware
4. **Dynamic manifest** — `/manifest.webmanifest` is an API route that prefixes `scope`, `start_url`, and icon/shortcut URLs with the ingress path
5. **SW registration** — uses `window.__ingress_path` to construct `{ingressPath}/sw.js` URL and `{ingressPath}/` scope
6. **SW precache** — receives `SET_INGRESS_PATH` message and prefixes all precache URLs accordingly

**No ingress = standalone mode**: all paths stay at `/` (backward compatible).

| Feature | Standalone | HA Ingress |
| --------- | ----------- | ------------ |
| SW URL | `/sw.js` | `/api/hassio_ingress/{token}/sw.js` |
| SW Scope | `/` | `/api/hassio_ingress/{token}/` |
| Manifest scope | `/` | `/api/hassio_ingress/{token}/` |
| Install prompt | ✅ | ✅ (HTTPS required) |
| Offline caching | ✅ | ✅ (HTTPS required) |

## HTTPS Requirement

PWA features (service worker, install prompt, push notifications) require a **secure context** — HTTPS or localhost.

| Access Method | HTTPS | PWA Available |
| --------------- | ------- | --------------- |
| Nabu Casa | ✅ auto | ✅ |
| DuckDNS + Let's Encrypt | ✅ addon | ✅ |
| Reverse proxy (Caddy, NPM) | ✅ | ✅ |
| Direct LAN HTTP | ❌ | ❌ |
| localhost | ✅ implicit | ✅ |

**Graceful degradation**: on insecure origins, Meitheal skips SW registration silently. The app works fully — you just won't get offline caching or the install prompt. Settings > App & PWA shows a status card with actionable HTTPS guidance.

## Cache Eviction Rules

As of v0.1.60, the service worker uses **4 scoped caches** with automatic eviction to prevent disk bloat:

| Cache | Strategy | Max Entries | TTL | Purpose |
| ------- | ---------- | ------------- | ----- | -------- |
| `precache` | Version-bump only | ~11 | ∞ (cleared on deploy) | App shell pages + icons |
| `static` | Cache-first | 100 | 7 days | CSS, JS, fonts, images |
| `api` | Network-first | 50 | 1 hour | API responses |
| `nav` | Network-first | 20 | 24 hours | Full page navigations |

Eviction runs on SW activation and every 5 minutes during active use. Entries are timestamped via the `Date` response header.

> **Dynamic IPs & multiple URLs**: Old versioned caches are fully deleted on version bump. Within a version, `maxEntries` caps prevent unbounded growth regardless of ingress token changes.

## Install Flow

Meitheal prompts for PWA installation through two paths:

1. **Install Banner** — a fixed bottom banner appears for first-time users on secure contexts. Dismissable with a 7-day cooldown (`localStorage`). Located in `PwaInstallBanner.astro`.
2. **Settings > App & PWA** — the PWA status card includes an Install button when the browser's install prompt is available, an Update button when a new SW is waiting, and companion URL handler / x-callback-url actions for mobile reopen flows.

The `beforeinstallprompt` event is captured in `Layout.astro` and stored on `window.__pwa_install_prompt`.

## Service Worker Update Flow

1. SW checks for updates every **5 minutes** (reduced from 60s for addon context)
2. When a new SW is found waiting, a toast appears: "Update available — Refresh"
3. User clicks → sends `SKIP_WAITING` → page reloads
4. `controllerchange` triggers `meitheal-sw-update` custom event for UI reactivity

---

Last updated: 2026-03-15 — Settings App & PWA shell, manifest screenshots, companion handoff actions
