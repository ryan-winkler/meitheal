# Meitheal

> Centralize your tasks. Automate the coordination. Get out of the way of life.

[![Docker Hub](https://img.shields.io/docker/v/coolockvillage/meitheal-amd64?label=Docker%20Hub&logo=docker)](https://hub.docker.com/r/coolockvillage/meitheal-amd64)

## What is Meitheal?

In the past, a meitheal (/ˈmʲɛhəlˠ/) was a village of humans working together. Today, running a household or homelab is a massive task, and your digital life is scattered.

What started as a simple to-do list forked from Vikunja to host on Home Assistant quickly evolved. We realized that to take Home Assistant from being just about automations and smart things, to being the literal OS for how your house operates, it needed a dedicated execution engine.

**Grocy** is used to write down and keep track of WHAT needs to be done, what is purchased, and what your inventory looks like.
**Meitheal** is the hub for WHEN to get things done, and WHERE to look for the information on the "shit I need to do."

Centralize your tasks, automate the coordination, and let technology get out of the way of life.

## Key Features

- **HA-Native Architecture** — Built from the ground up as a [Home Assistant app/add-on](https://www.home-assistant.io/apps/). Ingress proxy, Supervisor lifecycle, WebSocket events, and deep integration with your smart home. Not a wrapper — a native citizen.
- **Astro-First** — Built on [Astro](https://astro.build) with SSR, Astro 6, `ClientRouter` in standalone mode, and a domain-scoped CSS architecture. Strict performance budgets, self-hosted fonts, no external CDN.
- **Searchable Settings Shell** — Grouped `Personal`, `Workflow`, `Integrations`, `Automation & AI`, `App & PWA`, and `Danger Zone` sections with direct field search, summary badges, and ingress-safe hash deep links.
- **Bidirectional Calendar Sync** — Meitheal detects your HA calendar entities and syncs events automatically. Tasks → calendar, calendar → tasks.
- **Voice & Assist** — 8 LLM tools + 6 voice intents for HA Assist. Works with Gemini, OpenAI, Ollama — any conversation agent. "What's on my plate today?"
- **MCP Server** — 17 live Model Context Protocol tools at `/api/mcp`. Your AI coding agent can manage tasks, boards, labels, habits, and today summaries directly.
- **Multiple Views** — Dashboard, Today, Upcoming, task list, Kanban board, data table, calendar, habits, and Gantt. Drag-and-drop, swimlane management, inline editing.
- **Smart Notifications** — Multi-channel dispatch: sidebar bell, mobile push (Android/iOS), calendar reminders. Actionable buttons. Due-date scheduler.
- **Strategic Lenses** — RICE, HEART, and KCS scoring frameworks built into task evaluation.
- **PWA + Offline** — Service worker with 4 scoped caches. Works offline. Background sync. Web Share, Clipboard, Badging APIs.
- **Data Portability** — JSON/CSV export, raw SQLite download, settings import/export. Your data is yours.
- **Companion App** — Android shortcuts/widgets, iOS Siri/Apple Watch/CarPlay integration via HA Companion, plus companion-safe Settings reopen flows via URL handler and x-callback-url.
- **Device Triggers** — Fire HA automations from task events. Node-RED and n8n integration via webhooks.
- **Grocy Integration** — Auto-detects Grocy add-on. Stock-aware task checklists.
- **Proactive Reminders** — Configurable due-date reminder window. Push notifications for overdue tasks.
- **Accessibility** — WCAG 2.2 AA compliant. Keyboard navigation. ARIA live regions. High contrast support. Priority encoded by icon + color + text (color-blind safe).

## Screenshots

| Dashboard | Tasks | Kanban |
|-----------|-------|--------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Tasks](docs/screenshots/tasks.png) | ![Kanban](docs/screenshots/kanban.png) |

| Table | Settings |
|-------|----------|
| ![Table](docs/screenshots/table.png) | ![Settings](docs/screenshots/settings.png) |

## Quick Install on Home Assistant

1. **Settings** → **Add-ons** → **Add-on Store** → **⋮** → **Repositories**
2. Add: `https://github.com/Coolock-Village/meitheal`
3. Find **Meitheal** → **Install** → **Start** → **Open Web UI**

### Voice Setup

1. HA auto-discovers Meitheal on addon start → confirm in **Settings → Devices & Services**
2. Go to **Settings → Voice Assistants → [Your Agent] → Configure → LLM APIs** → select **"Meitheal Tasks"**
3. Expose `todo.meitheal_tasks` in **Settings → Voice Assistants → Expose**

## Architecture

Meitheal is an Astro-first, local-first execution engine.

| Layer | Stack |
|-------|-------|
| Framework | Astro 6 (SSR, Node adapter, ClientRouter) |
| Database | SQLite via libSQL + Drizzle ORM |
| Styling | Domain-scoped CSS partials + design tokens + Tailwind 4 tooling |
| Fonts | Outfit (headings), Geist (body), JetBrains Mono (code) — all self-hosted |
| Runtime | Node.js 22, Alpine 3.23 |
| Standards | OpenAPI 3.0.3, MCP, LLMs.txt |

### Monorepo Layout

- `apps/web` — Astro PWA frontend + API routes
- `meitheal-hub` — Home Assistant add-on package
- `integrations/home-assistant` — HA custom component
- `packages/domain-*` — Pure domain logic
- `tests/` — E2E (Playwright) + governance gates

## Non-Negotiables

- Astro-first architecture. Favor OSS [Astro integrations](https://astro.build/integrations/) when suitable.
- DDD boundaries, extensibility, and framework-driven behavior are core constraints.
- HA [app ecosystem](https://www.home-assistant.io/apps/) expectations and [publishing guidance](https://developers.home-assistant.io/docs/apps/publishing) compliance.
- Local-first, privacy-first. No external CDN, no telemetry.

## Ubiquitous Language

| Term | Meaning |
|------|---------|
| Meitheal | The system |
| The Hearth | Home Assistant host environment |
| Villagers | Users / household members |
| Endeavors | High-level goals / portfolios |
| Tasks | Units of work (not "issues") |
| Strategic Lenses | RICE, HEART, KCS scoring frameworks |

## Local Container Testing

```bash
# Build from repo root
podman build --build-arg BUILD_FROM="ghcr.io/home-assistant/amd64-base:3.23" \
  -f meitheal-hub/Dockerfile -t local/meitheal-hub .

# Run standalone (no HA Supervisor)
podman run --rm -p 3333:3000 -v /tmp/meitheal-data:/data \
  local/meitheal-hub /run-local.sh

# Verify
curl http://localhost:3333/api/health
```

## API Documentation

- OpenAPI 3.0.3 spec: `public/openapi.yaml`
- LLMs.txt: `public/llms.txt`
- MCP endpoint: `/api/mcp`

## Legal and Licensing

Meitheal uses a dual-track strategy:

- `meitheal-core`: clean-room Astro-native implementation.
- `meitheal-vikunja-adapter`: AGPL-compatible migration/bridge layer.

License: AGPL-3.0. See `docs/decisions/0001-legal-and-naming-strategy.md`.
