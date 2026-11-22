# Changelog

Meitheal uses GitHub Releases as the single source of truth for versioned release notes, changelogs, and upgrade instructions. Every release summary explains functional changes, upgrade impact, and any fixed runtime vulnerabilities or CVEs.

- **Releases & Notes:** [GitHub Releases](https://github.com/ryan-winkler/meitheal/releases)
- **Security Advisories:** [GitHub Security Advisories](https://github.com/ryan-winkler/meitheal/security/advisories)
- **User Documentation:** [README.md](README.md)

## Release Summary

- **0.0.2-canary** (Canary channel): Continuous validation channel tracking `dev`:
  - **Navigation, Tabler Look & Feel, and Shortcuts**: Migrated navigation to Tabler `nav-overflow` with visual SVG layout/theme/font pickers, unified `SettingsPanelCard` hierarchy and collapsible helper modals, editable keyboard shortcuts with contrast-safe badges, unified per-user vs server-wide sidebar/top-nav editor (including custom sections, Tabler icon picker, and task-view/board submenus), theme-adaptive profile avatars, and `transition:persist`-safe utility and Edit Profile portals.
  - **Locale & Visual Polish**: Completed Irish (`ga`) translation parity with zero missing keys, fixed contrast tokens on dark and accent-tinted navigation surfaces, removed redundant Settings status chrome, and refined toast notifications, growlers, and mobile swipe UX.
  - **Calendar, Tickets, & Release Automation**: Prevented due-date reminder calendar sync loops, preserved immutable task IDs in stored `#` references across Board prefix changes, added readable ticket-key links, and automated qualified Canary image promotion (`scripts/publish-canary-local.sh promote`) with scoped MCP/WebMCP/A2A agent tooling, OpenSSF Scorecard/Codacy verification, and hardened DOM/URL rendering paths.
- **0.0.1** (Stable baseline): Initial Home Assistant Add-on release (`meitheal-hub`) with Astro SSR runtime, Node.js built-in SQLite (`node:sqlite` `DatabaseSync`) storage, Home Assistant Ingress integration, calendar/to-do synchronization, and custom integration support. No prior publicly disclosed runtime CVEs apply to this baseline.
