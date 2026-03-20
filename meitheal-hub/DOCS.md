# Meitheal Add-on Docs

Meitheal is the Home Assistant-native execution hub for the practical work of running a home or homelab. It brings tasks, daily planning, routines, calendar-linked work, companion flows, voice control, and agent tooling into one local-first system.

## What You Get

- A Home Assistant add-on with an Astro SSR web app
- A bundled custom component that exposes todo, sensors, services, intents, and agent surfaces inside Home Assistant
- Search, Settings, PWA, companion, and offline flows that are aware of Home Assistant ingress
- Optional integrations for calendars, Grocy, Node-RED, n8n, webhooks, and agent protocols

## Installation

### Home Assistant add-on repository

1. Open **Settings** → **Add-ons** → **Add-on Store**
2. Open **⋮** → **Repositories**
3. Add `https://github.com/Coolock-Village/meitheal-ha-addon`
4. Install **Meitheal**
5. Start the add-on
6. Open the Web UI

### Local testing without Home Assistant

```bash
# Build from repo root
podman build --build-arg BUILD_FROM="ghcr.io/home-assistant/amd64-base:3.23" \
  -f meitheal-hub/Dockerfile -t local/meitheal .

# Run standalone (no Supervisor)
podman run --rm -p 3333:3000 -v /tmp/meitheal-data:/data \
  local/meitheal /run-local.sh

# Verify
curl http://localhost:3333/api/health
```

## First Run Inside Home Assistant

1. Confirm Home Assistant discovers the bundled Meitheal integration in **Settings → Devices & Services**
2. Open the add-on UI and confirm the dashboard loads behind ingress
3. Visit **Settings** in Meitheal to check integrations, companion guidance, App & PWA status, and agent protocol settings

## Home Assistant Surfaces

### Entities

- `todo.meitheal_tasks`
- `sensor.meitheal_active_tasks`
- `sensor.meitheal_overdue_tasks`
- `sensor.meitheal_total_tasks`

### Services

- `meitheal.create_task`
- `meitheal.complete_task`
- `meitheal.sync_todo`
- `meitheal.search_tasks`
- `meitheal.get_overdue_tasks`
- `meitheal.complete_task_by_tag`
- `meitheal.notify_overdue`

### Built-in voice support

Meitheal registers Home Assistant intents so core voice flows work even without an LLM. Exposing `todo.meitheal_tasks` to Assist gives you a fast path for common commands like adding tasks, completing tasks, checking what is overdue, and getting today-oriented summaries.

## Voice, LLM, and Agent Surfaces

When the custom component is available on HA 2026.3+, Home Assistant registers **Meitheal Tasks** as an LLM API.

Surface-specific counts matter here:

- Astro MCP: 18 tools
- Home Assistant MCP: 16 tools
- Home Assistant LLM API: 21 tools
- A2A: dynamic skills via the Meitheal agent card

The Home Assistant LLM API includes task CRUD, search, daily briefing, link management, remove-from-todo-list, area and goal listing, move-to-project, and goal progress updates.

## Calendar and Todo Sync

Meitheal includes bidirectional task syncing with Home Assistant todo and calendar surfaces.

### Calendar sync

When running as an HA add-on with `homeassistant_api: true`, Meitheal can:

1. Detect calendar entities
2. Pull calendar events into Meitheal task context
3. Push eligible task due dates back to HA calendars
4. Deduplicate repeated syncs safely

### Todo sync

The bundled custom component exposes `todo.meitheal_tasks`, which makes Meitheal visible in Home Assistant dashboards, Assist, and automation flows.

## Companion App and PWA

Meitheal is designed to stay usable through Home Assistant companion flows and as an installable PWA.

- **Settings → App & PWA** explains installability, update state, and HTTPS requirements
- companion-safe deep links use ingress-scoped paths
- x-callback-url and URL handler flows are surfaced directly in Settings
- offline support keeps the app shell and queued task changes available when connectivity drops

See `docs/companion-app-setup.md` and `docs/kcs/pwa-offline-guide.md` for deeper setup guidance.

## Runtime Notes

- Default database path: `/data/meitheal.db`
- Startup runs schema and migration checks
- Supervisor/API access uses `SUPERVISOR_TOKEN` when available
- Health endpoint: `GET /api/health`
- Ingress behavior is first-class: Meitheal is designed to stay inside the Home Assistant iframe and companion webviews

## Security

### AppArmor and container isolation

The add-on ships with a restrictive AppArmor profile and uses Home Assistant's add-on isolation model.

### Auth model

- Primary auth path: Home Assistant ingress and Supervisor identity headers
- No separate cloud auth is required
- Mutating routes use CSRF and origin/referer validation where applicable

### Additional protections

- structured logging with redaction
- rate limiting
- security headers
- backup and export surfaces

## Publishing Requirements

- `image` in `config.yaml` must keep the `{arch}` suffix
- published version tags must match the add-on version
- `repository.yaml` must remain present for repository publishing
- add-on assets such as `apparmor.txt`, `icon.png`, and `logo.png` must remain present

## Where To Read Next

- `README.md` — product story and quick orientation
- `WEBMCP.md` — agent protocol breakdown
- `docs/companion-app-setup.md` — mobile and companion details
- `docs/kcs/pwa-offline-guide.md` — offline and installability behavior
- `docs/kcs/search-hub-guide.md` — SearchHub and search parity
