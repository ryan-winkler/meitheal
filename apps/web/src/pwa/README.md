# PWA Runtime

This directory is reserved for PWA-related components and client-side logic.

## Architecture

- **`sw.js`** (`public/`) — Service worker with cache-first static assets, network-first API, offline fallback, push notifications
- **`sw-register.ts`** (`domains/offline/`) — Ingress-aware SW registration, handles `SET_INGRESS_PATH` and update lifecycle
- **`manifest.webmanifest.ts`** (`pages/`) — Dynamic manifest API route, prefixes URLs with ingress path when behind HA
- **`PwaInstallBanner.astro`** (`components/pwa/`) — Dismissible bottom banner for install prompt (permanent localStorage dismissal)
- **`offline.astro`** (`pages/`) — Offline fallback page with `role="alert"`

## Cache Strategy

| Cache | Strategy | Max Entries | TTL |
|-------|----------|-------------|-----|
| `precache` | Version-bump | ~11 | ∞ |
| `static` | Cache-first | 100 | 7 days |
| `api` | Network-first | 50 | 1 hour |
| `nav` | Network-first | 20 | 24 hours |

Eviction runs on activate + throttled every 5 min during fetch.

## Web APIs Integrated

| API | Purpose |
|-----|---------|
| Web Share | Native OS share dialog for tasks |
| Clipboard | Copy task URL/markdown |
| Badging | Pending task count on app icon |
| Vibration | Haptic feedback on drag-drop, completions |
| Screen Wake Lock | Focus mode during task sessions |
| Web Locks | Sync safety (prevents concurrent operations) |
| BroadcastChannel | Cross-tab state sync |
| PerformanceObserver | Web Vitals monitoring |
| Notification | Push notification opt-in with HA integration |

## HA Ingress Considerations

- SW scope and URL are prefixed with ingress path via `window.__ingress_path`
- Manifest `id` is stable (`/`) to prevent duplicate installations per ingress token
- `Service-Worker-Allowed: /` header set in middleware
- PWA requires HTTPS — graceful degradation on HTTP (no SW registration, no install prompt)
- Update checks every 5 minutes (not 60s — appropriate for HA addon)

## Companion App Integration

When running as an HA addon, the PWA complements the HA Companion App:

- Android shortcuts link to ingress paths (kanban, today, calendar)
- iOS actions register for Siri, Apple Watch, and CarPlay
- Actionable notifications with "Mark Done" buttons
- Deep-links route through ingress for in-app navigation
