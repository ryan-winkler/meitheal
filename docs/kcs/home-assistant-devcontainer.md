---
type: Runbook
title: Home Assistant devcontainer
description: Run the Supervisor development environment and verify Meitheal through ingress.
---

# Home Assistant devcontainer

Use a disposable development host for changes to ingress, Supervisor integration, App packaging, and Home Assistant services. The stack uses privileged containers and publishes local test ports. Keep it on a trusted network and use sample data.

## Start the editor-managed environment

1. Install devcontainer support in a compatible editor such as VS Code and open the repository.
2. Choose **Reopen in Container** using the checked-in [devcontainer configuration](../../.devcontainer/devcontainer.json).
3. In the container, run the **Start Home Assistant** editor task or run `supervisor_run`.
4. Build the candidate with Docker Buildx from the workspace root, using the architecture and base image in `meitheal-hub/build.json`. Push it to a registry reachable by the disposable Supervisor.
5. Stage the App manifest and AppArmor profile in the local App directory. In the staged copy, set `image` to the test registry’s image template and keep `version` aligned with the tested tag. Supervisor pulls a configured registry image during installation.
6. Run `ha store reload`. Install the local App and open its web UI from Home Assistant. Record the exact image digest, App and Home Assistant versions, ingress roles tested, and AppArmor state.

The workspace is mounted at `/workspaces/meitheal`. On current Supervisor versions, stage local App files in `/mnt/supervisor/apps/local/meitheal`. Older versions use `/mnt/supervisor/addons/local/meitheal`. Stage the files after Supervisor starts so its data-directory migration can run. The nested Docker and containerd stores use separate volumes so the inner engine can mount image layers.

## Local configuration and recovery

The Compose file supplies the development ports and service defaults. Copy [.env.example](../../.devcontainer/.env.example) to `.devcontainer/.env` if you need to set them explicitly, including to reuse the `meitheal-dev` project name. Keep any environment-specific credentials in the ignored local file.

| Service | Default local URL |
| --- | --- |
| Home Assistant | `http://localhost:7123/` |
| Supervisor API | `http://localhost:7357/` |
| Grocy | `http://localhost:9192/` |
| Node-RED | `http://localhost:1880/` |

Run the helper from the repository root. Check ownership before stopping a stack that may be shared.

```sh
./scripts/devcontainer-up.sh status
./scripts/devcontainer-up.sh up
./scripts/devcontainer-up.sh logs
./scripts/devcontainer-up.sh down
```

## Ingress trust checks

The App wrapper accepts ingress only from the Supervisor's documented TCP peer, `172.30.32.2`. The prefix from the App's Supervisor configuration takes precedence over the ingress header. Meitheal strips trailing slashes from that prefix, including the double slash returned by some Supervisor builds. Meitheal ignores legacy `X-Hass-*` headers. Supervisor 2026.10.4 or later is required to establish user and admin identity from the forwarded remote-user headers. If the version check fails, the web UI can still load through verified ingress, but user-specific privileges are unavailable. Restart only the App after resolving the connectivity or version problem. [Ingress contract](https://contributors.home-assistant.io/apps/guides/ingress/) · [Supervisor 2026.10.4](https://github.com/home-assistant/supervisor/releases/tag/2026.10.4).

With the App running, test the UI through Supervisor ingress as a regular user and as an administrator. Confirm both can load tasks and that only the administrator can manage API tokens. Check that links and the web manifest stay in the ingress scope. From a separate test container, send requests directly to the App with forged ingress and identity headers. Protected routes must return an authorization error, while the health check remains reachable. Native loopback calls stay local to the App container.

Open Tasks from a fresh browser session and inspect its network requests. JavaScript loaded by the board and its preloads should use the App's ingress path. A request to a bare `/_astro/` path goes to Home Assistant Core. The Vite build resolves script preloads relative to their importing script, so the same chunks also work in a standalone installation. [Vite build options](https://v8.vite.dev/config/build-options#build-modulepreload).

Open a large board's Table view and switch to Calendar or Timeline. Meitheal scopes links, forms and assets to ingress and streams oversized HTML. The check should still pass when the Table response exceeds 5 MiB. A request to the Home Assistant root or unscoped task links usually indicates a failed ingress rewrite. Check that a slow client limits queued socket data and that disconnecting cancels the upstream HTML stream.

The older Core coordinator calls native task routes without credentials. Direct sibling calls are denied by the new ingress boundary. Verify a credential-backed Core integration path before promoting the App if that integration is required.

For publishing and canary promotion, see the [release runbook](releasing.md).
