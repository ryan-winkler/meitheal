# Changelog

Meitheal uses GitHub Releases as the single source of truth for versioned release notes, changelogs, and upgrade instructions. Every release summary explains functional changes, upgrade impact, and any fixed runtime vulnerabilities or CVEs.

- **Releases & Notes:** [GitHub Releases](https://github.com/ryan-winkler/meitheal/releases)
- **Security Advisories:** [GitHub Security Advisories](https://github.com/ryan-winkler/meitheal/security/advisories)
- **User Documentation:** [README.md](README.md)

## Release Summary

- **0.0.4-canary** (Canary channel): Tracks `dev` for post-`0.0.3` changes before Stable promotion.
- **0.0.3** (Stable release): Delivers unified task modals, the Tabler rich-text editor, named Boards, navigation updates, SQLite storage upgrades, and Home Assistant Green performance improvements since `0.0.2`:
  - **Task Experience, Tabler Rich-Text Editor, and Configurable Properties**: Unifies the New Task and Task Detail modals across views. Adds the self-hosted Tabler HugeRTE visual and Markdown editor with working bullet lists, numbered lists, and image paste. Adds configurable Board ticket properties in **Settings -> Tasks & Boards** and modal header controls. Supports manual Table row order (`table_position`) and consistent Tabler layouts for Routines, Events, Checklists, and Shopping tickets.
  - **Named Boards, Grouping, and Workspace Continuity**: Adds Household, Shared, and Personal Boards with custom ticket-key prefixes and recoverable Board removal. Writes Board access grants to `meitheal-board-grants.json` and enforces Personal Pillars privacy limits. Groups Kanban, Table, and Timeline items by status, Area, Project, Epic, or assignee. Adds task pins, Focus mode, personal setup, and a configurable Dashboard.
  - **Navigation, Themes, Accessibility, and Localization**: Moves navigation to Tabler `nav-overflow` with SVG layout, theme, and font pickers. Adds opt-in Home Assistant theme matching and the Knight Rider theme. Completes Irish (`ga`) translation keys and tightens WCAG AA contrast tokens and persistent UI portals.
  - **Home Assistant Green Performance and SQLite Storage**: Applies automatic SQLite migrations `0009` through `0018` (`schema_version = 28`) and synchronizes pooled SQLite reader snapshots. Adds cgroup-aware `--v8-pool-size=1` limits and idle passive WAL checkpoints. Combines `/today` queries and caches SSR slots and Tabler icon sprites. Passes physical Home Assistant Green CPU (`13.44%`), memory, and latency checks.
  - **Integrations, Agent Security, and Supply Chain**: Stops due-date reminder calendar sync loops and preserves concurrent field edits and Home Assistant local due dates. Hardens Loki client backoff and safe ticket-key queries. Pins `pnpm 12.22.0`, `astral-sh/setup-uv v10.4.0`, and OpenSSF Scorecard `v2.5.0`, verifies Stable image attestations, and automates qualified Canary promotion. No new Meitheal runtime CVEs apply to this release.
- **0.0.2** (Stable release): Fixes recurring calendar imports, separates shared CalDAV invitation tasks, and preserves concurrent field versions during calendar sync. Adds the 64-icon precompiled Tabler sprite registry, task-oriented Settings groups, Today scroll tracking, and Home Assistant time-zone support for the Due Today sensor. Tightens agent access limits and outbound SSRF checks. No prior publicly disclosed runtime CVEs apply to this release.
- **0.0.1** (Stable baseline): Initial Home Assistant Add-on release (`meitheal-hub`) with Astro SSR runtime, Node.js built-in SQLite (`node:sqlite` `DatabaseSync`) storage, Home Assistant Ingress integration, calendar/to-do synchronization, and custom integration support. No prior publicly disclosed runtime CVEs apply to this baseline.
