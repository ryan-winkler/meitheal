---
description: How to run, test, and verify Meitheal locally during development
---

# Local Development & Testing

Meitheal has **three environment tiers**. Always use the right one for what you're verifying.

## Environment Tiers

| Tier | URL | What It Is | When to Use |
|------|-----|------------|-------------|
| 🔧 **Local Astro Dev** | `http://localhost:4321/` | Raw Astro SSR dev server (`npm run dev`) | UI changes, CSS, component work, JS logic. No HA Supervisor context. |
| 🏠 **HA Devcontainer** | `http://localhost:7123/` | Full HA Supervisor + Home Assistant via the checked-in devcontainer config | Ingress testing, HA API integration, addon lifecycle, config.yaml validation. |
| 🌐 **Live HA Production** | `http://ha.internal:8123/` | Real Home Assistant OS with full functionality (real devices, automations, entities) | Final verification of deployed addon image. **This is NOT a dev environment** — it runs released Docker images only. |

> **⚠️ IMPORTANT**: `ha.internal` is a **live production system** with real data, real automations, and real device integrations. Do NOT treat it as a development server. Changes here require a tagged release, CI Docker image build, and addon restart.

## Tier 1: Local Astro Dev Server

// turbo-all

```bash
cd /home/ryan/code/meitheal/apps/web
npm run dev -- --port 4500
```

- Fastest iteration cycle (sub-second HMR)
- Use for: CSS, layout, component logic, client-side JS
- **Limitations**: No `SUPERVISOR_TOKEN`, no ingress path rewriting, no HA WebSocket
- If port conflicts: use `--port 4500` or any available port
- Clean Vite cache if CSS breaks: `rm -rf node_modules/.vite .astro && npm run dev`

## Tier 2: HA Devcontainer (Recommended for HA Integration)

Per the [official HA app testing guide](https://developers.home-assistant.io/docs/apps/testing/):

### Setup (one-time)

1. Use the checked-in `.devcontainer/devcontainer.json` in this repo
2. Install editor support:
   - VS Code: [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
   - Antigravity: enable its devcontainer / reopen-in-container support
3. Open the repo and choose **Reopen in Container**
4. Run task **Start Home Assistant** from the integrated terminal task runner, or execute `supervisor_run`
5. Access HA at `http://localhost:7123/`
6. Confirm the addon appears in **Local Apps**

### Terminal-first alternative

If you are not using an editor-managed container, start the same stack with:

```bash
./scripts/devcontainer-up.sh up
```

### What This Gives You

- Full Supervisor context (`SUPERVISOR_TOKEN` available)
- Ingress path rewriting works as in production
- HA API, WebSocket, entity access, automations
- Addon lifecycle (start, stop, restart, logs, config)
- Calendar/Todo sync testing against real HA entity types
- One checked-in configuration path that works for both Antigravity and VS Code

### Remote Device Testing (Alternative)

If you need physical hardware (serial ports, USB, Zigbee):

1. Install [Samba](https://my.home-assistant.io/redirect/supervisor_addon/?addon=core_samba) or [SSH](https://my.home-assistant.io/redirect/supervisor_addon/?addon=core_ssh) addon on HA device
2. Copy addon files to `/addons/meitheal-hub/` on the device
3. Comment out `image:` in `config.yaml` (forces local build)
4. Rebuild from HA → Settings → Add-ons → Meitheal → Rebuild

## Tier 3: Live HA Production (`ha.internal`)

- URL: `http://ha.internal:8123/868b2fee_meitheal` (sidebar panel)
- Ingress: `http://ha.internal:8123/api/hassio_ingress/nSNXnUWXfe2DcUzE_X_4wsGWAwTIUze7_WdXaSsXJwo/`
- Runs the **released Docker image** from GHCR/Docker Hub
- Real devices, automations, entities, calendars, todo lists, Grocy

### Deploy to Production

1. Bump version in `config.yaml`, `run.sh`, `package.json`
2. `git commit && git tag v{VERSION}`
3. `git push origin main --tags`
4. CI builds Docker images (`publish-addon-images.yml`)
5. HA → Settings → Add-ons → Meitheal → **Restart**

## Decision Matrix

| What You're Testing | Use Tier |
|---------------------|----------|
| CSS, layout, UI components | 🔧 Local Dev |
| Client-side JS, tab switching, modals | 🔧 Local Dev |
| Ingress path rewriting | 🏠 Devcontainer |
| HA WebSocket / Supervisor API | 🏠 Devcontainer |
| Calendar/Todo sync | 🏠 Devcontainer |
| Addon startup / config.yaml | 🏠 Devcontainer |
| Final acceptance on real data | 🌐 Production |
| Version tag validation | 🌐 Production |
