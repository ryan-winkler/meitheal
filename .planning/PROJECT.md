# Meitheal — Active Delivery Snapshot

## What This Is

Meitheal is a Home Assistant add-on for task/project management. The core feature-completion sprint landed subtasks, recurrence, checklist UX, SQL repository migration, Smart Today, and version tooling. The active parallel work now focuses on **cross-page shell quality**, **search/navigation ergonomics**, and **Astro-native maintainability**.

## Core Value

Keep Meitheal competitive as a Home Assistant-native execution engine: make critical controls discoverable, reduce client-controller duplication, preserve ingress safety, and keep the codebase understandable enough to keep shipping.

## Current State (2026-03-19)

- Core sprint: hierarchy/recurrence/checklist work delivered
- SQL repository migration delivered across task/board/settings-related routes
- Smart Today and version-tooling phases delivered
- Settings now uses a searchable shell with grouped navigation, summary cards, App & PWA companion affordances, and real manifest screenshots
- The dashboard and habits now use the mature unified shell language, with the next rollout order queued for Today, Upcoming, Calendar, Kanban, and Table
- Universal search hub work is present locally with repo-wide typecheck green; remaining follow-up is Tier 2 HA verification and polish
- Tier 2 HA verification is currently blocked on this workstation by Docker socket permissions
- A new research/discuss track, `human-agent-ddd-core`, is active to replace `Epic/Story` with `Area/Goal/Project/Task/Routine` and add bot-safe task orchestration semantics before execution code begins

## Active Goals

1. **Page shell rollout** — extend the mature unified bar + section shell from dashboard and habits into the remaining Home Assistant-facing task views
2. **Settings closeout** — complete Tier 2 verification for ingress-safe hashes, companion handoff, and PWA behavior
3. **Search stabilization** — finish type-clean universal search orchestration through `domains/search/` and `/api/search`
4. **Controller decomposition** — continue breaking oversized client controllers into lifecycle-safe modules
5. **Docs/KCS accuracy** — keep README, AGENTS, planning docs, and runbooks synchronized with the shipped UX
6. **Human-agent DDD core** — define the new strategic hierarchy, task kinds, bot handoff model, and offline-safe merge contract before implementation

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
