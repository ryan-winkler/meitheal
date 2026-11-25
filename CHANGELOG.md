# Changelog

All notable changes to **Meitheal** are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) for both human readability and machine parsing, and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

- **Releases & Upgrade Notes:** [GitHub Releases](https://github.com/ryan-winkler/meitheal/releases)
- **Security Advisories:** [GitHub Security Advisories](https://github.com/ryan-winkler/meitheal/security/advisories)
- **User Documentation:** [README.md](README.md)

## [0.0.4-canary] - 2026-11-25 (Canary channel)

Continuous validation release built from `dev`. Entries below use plain, scannable descriptions grouped by change type.

### Added

- **Unified Kanban Card Across Dashboard & Boards**: Share one canonical Tabler `KanbanTaskCard` layout with the yellow corner promoted ribbon, reaction counter, more-actions menu, and 6-icon quick-action bar across both Kanban lanes and Dashboard Recent Tasks.
- **PWA Offline Outbox & Installable Quick-Capture Shortcuts**: Queue offline task creations in IndexedDB with Background Sync replay, add W3C manifest `shortcuts`, Web Share Target, `180×180` Apple touch icon, post-install notification permission prompt, and installable `/new?kind=...` task-type shortcuts with full Shopping and Checklist editors.
- **Gantt Date Navigation & Field Update Feedback**: Add Previous, Today, and Next date steppers, a live visible date-range pill, automatic edge expansion, canvas drag panning, `Shift+Wheel` horizontal scrolling, and immediate inline save status pills when ticket fields update.
- **Tabler Icon & Color Picker**: Replace raw icon and color inputs in New Area and Board Pillars with a reusable Tabler Icon & Color Picker.
- **Curated Light Themes & Per-User Notifications**: Add `Zen Paper`, `Catppuccin Latte`, `Nordic Frost`, and `Solarized Dawn` light themes with WCAG AA tokens and `96×64` Tabler preview tiles, plus browser-local notification preferences and optional alert chime in Settings.
- **Routines Time-of-Day & Curated Kind Layouts**: Add optional `BYHOUR` and `BYMINUTE` recurrence times, curated default layouts for `Quick Capture`, `Shopping`, `Checklist`, `Event`, and `Routine Task`, and a per-user `After creating a task` setting.

### Changed

- **Mobile-First Workspace & Settings**: Default mobile phone task routes to Table view, replace the stacked mobile Settings drawer with a sticky horizontal Tabler pill bar, and default mobile Calendar to an edge-to-edge Google Calendar-style Day timeline with swipe navigation.
- **Area Terminology Unification**: Remove fabricated `Default` Area badges on unassigned Dashboard cards and unify Board Groups and Settings labels from `Default Project` to `Default Area`.
- **Keyboard Shortcuts Modal, Search Keycap & Navigation Polish**: Restyle the `/` search keycap across mobile, tablet, and desktop, align `/meh·hal/` directly beneath the `meitheal.` wordmark in the sidebar header, give the Keyboard Shortcuts modal structured headers and non-wrapping footer actions, and standardize Boards `+ New Task`, Today `Archive completed`, and Settings header buttons to compact themed Tabler controls.
- **Kanban & Table SortableJS Reordering**: Upgrade Kanban and Table views to SortableJS with exact intra-lane and cross-group drop positioning, restored filled task colors at rest, and GPU-composited settle animations.
- **Editable Date/Time Picker & RICE Sliders**: Upgrade the shared Tabler Date Picker with direct keyboard typing and optional time chips, replace RICE spinners with synced range sliders, and place `Defer` directly left of `Mark as Done` in Task Detail.
- **Shopping Lists, Checklists & New Task Footer**: Place Shopping and Checklist items directly below Title with Tabler quantity steppers, Grocy-compatible units, SortableJS touch drag fallback, and a single-row Tabler split-button footer.
- **Sponsor & Support Links**: Update Become a Sponsor links to `mailto:Sponsor@meitheal.io` and security contacts to `hi@meitheal.io`.

### Fixed

- **Mobile Task Detail Modal Scroll Trap & Comment Input Clipping**: Convert mobile `#task-detail-panel` to a full-height `100dvh` flex sheet with a single `.td-scroller` container so scrolling never gets stuck or loses half the page, hide desktop-only Focus Mode on mobile, and prevent vertical text clipping in `"Add a comment"`.
- **Dashboard Recent Tasks Promote Star Overlap**: Eliminate overlap between the Promoted star/ribbon and Ask AI action button by adopting the canonical Kanban card layout with top-right ribbon and bottom quick-action bar.
- **Gantt Drag Bounce-Back**: Persist moved and resized Gantt bars optimistically across canonical and hierarchy state with clean rollback on failure so bars stay in place without refreshing.
- **Home Assistant Ingress Keepalive & Board Verification Banner**: Add a same-origin 15-minute ingress keepalive, display names from verified Home Assistant ingress or the current roster, stop detaching verified Boards on window focus/online events, and auto-recover `409` work-access conflicts.
- **Pre-0016 Database Upgrades & Calendar Sync Loops**: Accept legacy `tasks_stall_transition` triggers and `vikunja_labels_title_idx` during schema upgrades, and prevent bidirectional Home Assistant calendar sync from duplicating tickets.

### Security

- **Service Worker Cache & Token Renewal Hardening**: Prevent `401`, `403`, `5xx`, opaque, and redirected responses from entering Cache Storage, enforce explicit expiration checks during agent token renewal, require admin access on `GET /api/integrations/status`, and render Changelog inline code with escaped tokens instead of raw HTML.

## [0.0.3] - 2026-09-12 (Stable release)

### Added

- **Unified Modals & Rich Text**: Unify task creation and detail modals with the self-hosted Tabler HugeRTE editor, inline title editing, and configurable board properties, routines, events, and shopping lists.
- **Multi-Board Sharing & Access Control**: Add multi-board sharing, scoped role-based access control, and Home Assistant time-zone support for the Due Today sensor.

### Changed

- **Performance & Green Hardware Tuning**: Add SQLite connection pooling, WAL checkpoint tuning, precompiled Tabler SVG sprites, task-oriented Settings groups, and Today scroll tracking.

### Fixed

- **Calendar Sync Conflicts**: Improve bidirectional calendar sync conflict handling and error diagnostics.

### Security

- **Agent & SSRF Hardening**: Harden scoped MCP, WebMCP, and A2A agent endpoints and URL/DOM validation. No prior publicly disclosed runtime CVEs apply to this release.

## [0.0.1] - 2026-06-01 (Stable baseline)

### Added

- **Initial Home Assistant Add-on Release**: Launch `meitheal-hub` with Astro SSR runtime, Node.js built-in SQLite (`node:sqlite` `DatabaseSync`) storage, Home Assistant Ingress integration, calendar and to-do synchronization, and custom integration support.

### Security

- **Baseline Security Posture**: Local-first storage with no external telemetry or phone-home license checks. No prior publicly disclosed runtime CVEs apply to this baseline.

[0.0.4-canary]: https://github.com/ryan-winkler/meitheal/compare/v0.0.3...dev
[0.0.3]: https://github.com/ryan-winkler/meitheal/compare/v0.0.1...v0.0.3
[0.0.1]: https://github.com/ryan-winkler/meitheal/releases/tag/v0.0.1
