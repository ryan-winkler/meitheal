# Canary Changelog

All notable changes in the **Meitheal Canary** Home Assistant add-on (`meitheal-hub-canary`) are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) for both human readability and machine parsing, and follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For stable releases, see [Meitheal Releases](https://github.com/ryan-winkler/meitheal/releases).

## [0.0.4-canary] - 2026-11-25 (Canary channel)

Continuous development snapshot built from `dev`.

### Added

- **Canonical Kanban Cards Everywhere**: Reuse one Tabler `KanbanTaskCard` across Kanban and Dashboard Recent Tasks with top-right yellow promoted ribbon, reaction counter, `⋮` context menu, and 6-icon quick-action bar.
- **PWA Offline Outbox & Installable Shortcuts**: Add IndexedDB offline task queuing with Background Sync replay, post-install notification prompt, App & Companion Permissions & Offline Sync controls, W3C manifest `shortcuts`, Web Share Target, `180×180` `apple-touch-icon.png`, and `/new?kind=...` Quick-Capture PWAs with Shopping and Checklist editors.
- **Gantt Date Steppers & Inline Field Save Feedback**: Add Previous, Today, and Next date steppers, live date-range pill, automatic edge expansion, canvas panning, `Shift+Wheel` horizontal scrolling, and inline `role="status"` save pills on ticket field updates.
- **Tabler Icon & Color Picker**: Replace raw icon and color inputs in New Area and Board Pillars with a reusable Tabler Icon & Color Picker.
- **Curated Light Themes & Per-User Notifications**: Add `Zen Paper`, `Catppuccin Latte`, `Nordic Frost`, and `Solarized Dawn` light themes with WCAG AA tokens and `96×64` preview tiles, plus browser-local notification settings and optional chime.
- **Routines Time-of-Day & Curated Kind Layouts**: Add optional `BYHOUR`/`BYMINUTE` time fields on Routines and recurrences, curated layouts per task kind, and a per-user `After creating a task` setting.

### Changed

- **Mobile Workspace, Settings & Calendar**: Default mobile phone task views to Table, convert mobile Settings navigation into a single-row sticky Tabler pill strip, and default mobile Calendar to a Google Calendar-style Day timeline with swipe navigation.
- **Area Vocabulary Unification**: Remove fabricated `Default` Area badges on Dashboard cards without an assigned area and unify `Default Project` copy in Board Groups and Settings to `Default Area`.
- **Keyboard Shortcuts Modal, Search Keycap & Header Polish**: Style the `/` search keycap across mobile, tablet, and desktop, align `/meh·hal/` directly beneath `meitheal.` in the sidebar header, upgrade the Keyboard Shortcuts modal layout and footer actions, and standardize Boards `+ New Task`, Today `Archive completed`, and Settings header buttons to compact Tabler controls.
- **Kanban & Table SortableJS Reordering**: Enable exact intra-lane and cross-group SortableJS reordering with restored filled task colors at rest and GPU-composited settle animations.
- **Editable Date/Time Picker, RICE Sliders & Shopping Lists**: Add direct keyboard entry and time chips to the Date Picker, synced range sliders to RICE editors, Grocy unit selectors and touch-safe SortableJS ordering to Shopping Items, and a single-row split-button footer on New Task.

### Fixed

- **Mobile Task Detail Modal Scroll Trap & Comment Clipping**: Make `#task-detail-panel` a full-height `100dvh` flex sheet on mobile with a single `.td-scroller` container, hide desktop-only Focus Mode on mobile, and prevent `"Add a comment"` textarea vertical clipping.
- **Recent Tasks Promote Star Overlap**: Fix overlap between Promote star/ribbon and Ask AI button by unifying Dashboard Recent Tasks onto `KanbanTaskCard`.
- **Gantt Bar & Milestone Bounce-Back**: Persist horizontal drags, resizes, and inline date edits optimistically across canonical and hierarchy state with clean rollback on failure.
- **Home Assistant Ingress Keepalive, Display Names & Board Verification**: Add a 15-minute same-origin ingress keepalive, extend route-restore retention to 4 hours, display names from verified Home Assistant ingress or the current roster, stop detaching verified Boards on `window.focus`/`online`, and auto-recover `409` work-access conflicts.
- **Pre-0016 Upgrade Migrations & Calendar Sync Loops**: Allow legacy `tasks_stall_transition` triggers and `vikunja_labels_title_idx` during schema v28 upgrades, and stop bidirectional calendar sync from duplicating tickets.

### Security

- **Service Worker Cache, Token Renewal & Safe Changelog Rendering**: Never store `401`, `403`, `5xx`, opaque, or redirected responses in Cache Storage, enforce explicit expiration checks during agent token renewal, require admin access on `GET /api/integrations/status`, and render Changelog inline code with escaped tokens instead of raw HTML.

[0.0.4-canary]: https://github.com/ryan-winkler/meitheal/compare/v0.0.3...dev
