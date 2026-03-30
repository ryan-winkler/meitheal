---
description: "How to run, test, and verify Meitheal locally during development"
---

# Local Development & Testing

Meitheal has three environment tiers. Use the correct tier for the change you are making.

## Environment Tiers

| Tier | URL | What It Is | When to Use |
|------|-----|------------|-------------|
| Local Astro Dev | `http://localhost:4321/` | Raw Astro SSR dev server (`npm run dev`) | UI changes, CSS, component work, client-side JS |
| HA Devcontainer | `http://localhost:7123/` | Full Home Assistant Supervisor environment | Ingress testing, HA API integration, addon lifecycle, config validation |
| Live HA Production | `http://ha.internal:8123/` | Real Home Assistant OS with real data | Final verification of released addon images only |

## Tier 1: Local Astro Dev

```bash
cd /home/ryan/code/meitheal/apps/web
npm run dev -- --port 4500
```

Use Tier 1 for CSS, layout, component behavior, and client-side JavaScript.

## Tier 2: HA Devcontainer

Use the checked-in devcontainer in Antigravity or VS Code, then run the `Start Home Assistant` task.

Alternative terminal management commands:

```bash
./scripts/devcontainer-up.sh up
./scripts/devcontainer-up.sh status
./scripts/devcontainer-up.sh logs
./scripts/devcontainer-up.sh down
```

Use Tier 2 for ingress, HA WebSocket, Supervisor API, addon lifecycle, calendar or todo sync, and Home Assistant-specific verification.

## Tier 3: Production

Use production only to verify a released addon image against real Home Assistant data. Do not treat it as a development environment.