---
description: Start/stop the HA devcontainer stack for integration testing
---

# Devcontainer Management

// turbo-all

Start, stop, or check the HA Supervisor devcontainer stack.

This workflow supports both Antigravity and VS Code. The repo ships a checked-in
[`/.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json)
configuration for editor-managed containers, plus a
`./scripts/devcontainer-up.sh` helper for stack status, recovery, and logs.

## Editor-managed startup

Use this path when you want the repo mounted directly inside the container.

1. Install devcontainer support in your editor
2. Open the repo in Antigravity or VS Code
3. Run **Reopen in Container**
4. After the container boots, run the **Start Home Assistant** task or execute:

```bash
supervisor_run
```

## Stack management from a terminal

Use this path to inspect, recover, or tail the supporting HA stack. For full
Tier 2 verification with the repo mounted inside the container, use the
editor-managed startup above.

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

## Host console protection

The HA service masks guest `getty@tty1.service`, `getty@.service`, and
`serial-getty@.service` before starting `/sbin/init`.
Keep this guard in the Compose startup command so every recreated container
applies it before guest systemd starts. A privileged guest console can claim
the host display terminal and close its desktop session.

Use `/usr/bin/systemctl --root=/ mask` for this step. The explicit binary path
bypasses the image's `systemctl` shim, and `--root=/` applies the mask before
systemd runs. The startup shell stops if masking fails. Editor post-start
hooks run after init and are too late for this guard.

## Agent preflight

Before claiming Tier 2 verification, confirm the editor-managed devcontainer is
running. Use the helper script to inspect or recover the supporting stack:

```bash
./scripts/devcontainer-up.sh status
./scripts/devcontainer-up.sh up
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

## After devcontainer verification → Publishing

Once Tier 2 verification passes, code reaches users through **two channels**:

### Canary (Automatic)

Pushing to `main` auto-triggers `publish-canary-images.yml` — no manual steps. Canary users get the update on next HA repo refresh.

> **⚠️** Do NOT manually edit `meitheal-hub-canary/config.yaml` version — it is CI-managed.

### Stable (Manual — Step-by-Step)

```bash
# 1. Bump version (updates 4 files atomically)
node scripts/bump-version.mjs patch

# 2. Verify all files in sync
node scripts/check-version-sync.mjs

# 3. Update CHANGELOG.md

# 4. Commit, tag, push
git add -A
git commit -m "🔖 release v{VERSION}"
git tag v{VERSION}
git push origin main --tags
```

CI builds images via `publish-addon-images.yml`. Verify on HA: Settings → Add-ons → Meitheal → Check for updates.

See `docs/kcs/releasing.md` for the full runbook.
