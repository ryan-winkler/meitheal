# Changelog

Meitheal uses GitHub Releases as the single source of truth for versioned release notes, changelogs, and upgrade instructions. Every release summary explains functional changes, upgrade impact, and any fixed runtime vulnerabilities or CVEs.

- **Releases & Notes:** [GitHub Releases](https://github.com/ryan-winkler/meitheal/releases)
- **Security Advisories:** [GitHub Security Advisories](https://github.com/ryan-winkler/meitheal/security/advisories)
- **User Documentation:** [README.md](README.md)

## Release Summary

- **0.0.2-canary** (Canary channel): Continuous validation channel tracking `dev`, adding scoped MCP/WebMCP/A2A agent tooling, OpenSSF Scorecard and Codacy supply-chain verification, and hardened URL/SSRF and DOM rendering paths.
- **0.0.1** (Stable baseline): Initial Home Assistant Add-on release (`meitheal-hub`) with Astro SSR runtime, Node.js built-in SQLite (`node:sqlite` `DatabaseSync`) storage, Home Assistant Ingress integration, calendar/to-do synchronization, and custom integration support. No prior publicly disclosed runtime CVEs apply to this baseline.
