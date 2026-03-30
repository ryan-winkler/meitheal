---
description: "Start, stop, or inspect the Home Assistant devcontainer stack for Meitheal"
---

# Devcontainer Management

Use the checked-in devcontainer when you need full Home Assistant Supervisor context.

## Start the stack

```bash
./scripts/devcontainer-up.sh up
```

Access points after startup:

- HA UI: `http://localhost:7123/`
- Supervisor API: `http://localhost:7357/`
- Grocy: `http://localhost:9192/`
- Node-RED: `http://localhost:1880/`

## Stop the stack

```bash
./scripts/devcontainer-up.sh down
```

## Check status

```bash
./scripts/devcontainer-up.sh status
```

## Tail logs

```bash
./scripts/devcontainer-up.sh logs
```

Use this workflow for ingress, HA API or WebSocket, Supervisor integration, addon lifecycle, calendar or todo sync, and other Home Assistant-specific verification.