# Meitheal

> Your homelab's execution layer.

[![Docker Hub](https://img.shields.io/docker/v/coolockvillage/meitheal-amd64?label=Docker%20Hub&logo=docker)](https://hub.docker.com/r/coolockvillage/meitheal-amd64)

## What is Meitheal?

In the past, a meitheal (/ˈmʲɛhəlˠ/) was a village of humans working together. Today, running a household or homelab is a massive task, and your digital life is scattered.

**Grocy** tracks WHAT needs to be done. **Meitheal** is the hub for WHEN to get things done, and WHERE to look for everything.

Centralize your tasks, automate the coordination, and let technology get out of the way of life.

## Key Features

- **HA-Native** — Built as a first-class [Home Assistant app](https://www.home-assistant.io/apps/). Ingress, WebSocket, Supervisor lifecycle.
- **Built on Astro** — [Astro](https://astro.build) SSR, ViewTransitions, strict perf budgets. Self-hosted fonts (Outfit, Geist).
- **Calendar Sync** — Bidirectional sync with HA calendar entities.
- **Voice & Assist** — 8 LLM tools for any HA conversation agent.
- **Smart Notifications** — Sidebar, mobile push, calendar reminders. Actionable buttons.
- **3 Views** — List, Kanban, Table. Drag-and-drop, swimlanes, inline editing.
- **Data Portability** — JSON/CSV export, SQLite download, settings backup.

## Quick Install

1. **Settings** → **Add-ons** → **Add-on Store** → **⋮** → **Repositories**
2. Add: `https://github.com/Coolock-Village/meitheal-ha-addon`
3. Find **Meitheal** → **Install** → **Start** → **Open Web UI**

> **Updating:** After pushing new images, go to the add-on → **⋮** → **Check for updates**. Then **Update** + **Restart**.

## Screenshots

*Screenshots will be added once the UI is fully styled.*

## Local Testing

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

## Dev Build & Push

```bash
# Login once
docker login -u coolockvillage

# Build and push :dev tag
./meitheal-hub/build-push-dev.sh

# Build and push a versioned release
./meitheal-hub/build-push-dev.sh v0.1.0
```

## Files

| File | Purpose |
|------|---------|
| `config.yaml` | Add-on manifest (name, arch, ingress, options) |
| `Dockerfile` | Multi-stage build — Astro build + HA base image runtime |
| `build.json` | Architecture-specific base image registry |
| `run.sh` | Production entrypoint (uses bashio + Supervisor) |
| `run-local.sh` | Local testing entrypoint (standalone, no bashio) |
| `build-push-dev.sh` | Dev script to build + push to Docker Hub |
| `icon.png` | Add-on store icon (128×128) |
| `logo.png` | Add-on store logo (250×100) |
| `rootfs/` | Grafana Alloy config + dashboards |
| `DOCS.md` | Setup and operations details |

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `log_level` | `debug\|info\|warn\|error` | `info` | Logging verbosity |
| `log_redaction` | `bool` | `true` | Redact sensitive data in logs |
| `audit_enabled` | `bool` | `true` | Enable audit trail |
| `loki_url` | `str` | Loki add-on URL | Log aggregation endpoint |
