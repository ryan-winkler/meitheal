---
description: Start/stop the HA devcontainer stack for integration testing
---

# Devcontainer Management

// turbo-all

Start, stop, or check the HA Supervisor devcontainer stack.

This workflow supports both Antigravity and VS Code. The repo ships a checked-in
[`/.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json)
configuration for editor-managed containers, and a headless
`./scripts/devcontainer-up.sh` helper for terminal-first agents.

## Editor-managed startup

Use this path when you want the repo mounted directly inside the container.

1. Install devcontainer support in your editor
2. Open the repo in Antigravity or VS Code
3. Run **Reopen in Container**
4. After the container boots, run the **Start Home Assistant** task or execute:

```bash
supervisor_run
```

## Headless startup

Use this path for bots, terminal-only workflows, or when you only need the HA
stack running.

### Start the stack

```bash
./scripts/devcontainer-up.sh up
```

Access points after startup:

- **HA UI**: <http://localhost:7123/>
- **Supervisor API**: <http://localhost:7357/>
- **Grocy**: <http://localhost:9192/>
- **Node-RED**: <http://localhost:1880/>

### Stop the stack

```bash
./scripts/devcontainer-up.sh down
```

### Check status

```bash
./scripts/devcontainer-up.sh status
```

### Tail HA logs

```bash
./scripts/devcontainer-up.sh logs
```

## Agent preflight

Before claiming Tier 2 verification, run:

```bash
./scripts/devcontainer-up.sh status || ./scripts/devcontainer-up.sh up
```

## When to use

Use the devcontainer for any change that touches:

- Ingress path rewriting (`middleware.ts`, `serve.mjs`, `ingress-policy.ts`)
- HA API / WebSocket (`domains/ha/`, `domains/todo/`)
- Supervisor API (`run.sh`, `config.yaml`, `llm_api.py`)
- Addon lifecycle (start/stop/restart, build commands)
- Calendar/Todo sync
- Entity exposure or LLM API registration

For CSS, layout, and component-only changes, use `npm run dev` in `apps/web/` instead.
