# Meitheal — Active Delivery Snapshot

## What This Is

Meitheal is a Home Assistant-native household and homelab execution hub, shipped as a Home Assistant add-on. The core feature-completion sprint landed subtasks, recurrence, checklist UX, SQL repository migration, Smart Today, version tooling, a docs-narrative refresh, the complete unified page shell rollout across all 7 task views, search hub upgrade, settings redesign with full controller decomposition, pillars domain, strategic rules engine, progress & growth unification, and 37+ phases of code quality hardening (XSS, memory leaks, accessibility, inline style elimination, crash protection).

## Core Value

Keep Meitheal competitive as a Home Assistant-native execution engine: make critical controls discoverable, reduce client-controller duplication, preserve ingress safety, and keep the codebase understandable enough to keep shipping.

## Current State (2026-04-28)

- **Core sprint complete:** hierarchy/recurrence/checklist/SQL migration/Smart Today/version tooling all delivered
- **Unified page shell:** all 7 pages (dashboard, habits, today, upcoming, calendar, kanban, table) use the mature `UnifiedBar` shell
- **Settings:** searchable shell with grouped navigation, summary cards, App & PWA companion affordances, keyboard nav, and full controller decomposition (7 domain controllers)
- **Search hub:** universal search across tasks, boards, saved filters, settings, pages, and actions — HA search/LLM/MCP parity
- **Pillars domain:** complete with CRUD, principles, associations, slug URLs, AI integration, 15 E2E tests
- **Strategic rules engine:** rule-driven framework assignment, weighted RICE, settings UI, 9 domain tests
- **Code quality:** XSS hardened (innerHTML → replaceChildren), memory-safe (managed listeners + AbortSignals), crash-protected (global error handler), `transition:all` eliminated, native dialogs migrated, client logging unified
- **Typecheck:** green (`pnpm check` passes)
- **Tests:** 319+ at last full run
- **Version:** `0.0.1` (unreleased — needs bump to `0.1.0` for first public beta)

## Blockers

1. **Tier 2 HA verification** — 5 gates open (SET-08, SET-12, SHELL-33, STM-15, Phase 09). Blocked by Docker socket permissions on Kubuntu.
2. **No release artifacts** — no CHANGELOG.md, no CONTRIBUTING.md, no GitHub Release, no tagged build.
3. **Canary drift** — canary version stuck at commit `154f292` from 2026-03-23.

## Active Goals

1. **Tier 2 closeout** — restore Docker on Kubuntu, run devcontainer verification for all 5 open gates
2. **Release hardening** — bump version to `0.1.0`, write CHANGELOG, tag and build
3. **Phase 04.2** — expose hierarchy (areas/goals/projects) via API + sidebar navigation tree
4. **Phase 15** — hierarchy architecture overhaul (resolve Area/Project duplication, routine templates)
5. **Phase 16** — unified `/tasks` page with hash-based view switching
6. **Phase 18** — task modal overhaul

## Tech Stack

- Astro 6 SSR (Node adapter) with `ClientRouter` in standalone mode
- SQLite via `@libsql/client` + Drizzle ORM repositories
- TypeScript 5.9 strict mode
- pnpm 10.8 monorepo with 5 domain packages
- Tailwind 4 tooling + 18 CSS partials

## Constraints

- **Astro-native/first** — no React, no SPA patterns
- **HA Supervisor ingress** — all URLs must be ingress-aware
- **Tiered verification** — UI work needs Tier 1, ingress/HA/PWA work needs Tier 2 before closeout
- **DDD boundaries** — new features in appropriate bounded contexts
- **KCS** — all behavior changes documented inline
- **Production-quality** — no dummy data, no hardcoded assumptions
