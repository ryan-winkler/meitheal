---
description: "Use when editing Home Assistant-sensitive Meitheal code such as ingress, middleware, HA domains, addon lifecycle, sync, or Supervisor integration. Covers Tier 2 verification and ingress constraints."
applyTo: "apps/web/src/domains/ha/**, apps/web/src/domains/todo/**, apps/web/src/middleware.ts, apps/web/scripts/serve.mjs, meitheal-hub/**, integrations/home-assistant/**"
---

# Meitheal Home Assistant Integration Rules

- Treat Home Assistant compatibility as a first-class constraint.
- For ingress, HA API or WebSocket, Supervisor API, addon lifecycle, and sync changes, do not claim verification from Tier 1 alone.
- Canonical Tier 2 flow: reopen `.devcontainer/devcontainer.json` in Antigravity or VS Code and run `Start Home Assistant`.
- Use `./scripts/devcontainer-up.sh` for stack status, recovery, and logs around the devcontainer environment.
- Keep ingress behavior safe: normalize `//` paths, preserve ingress-prefixed asset and fetch behavior, and never escape the iframe with bare-root redirects.
- If work touches supervisor, addon config, or runtime lifecycle, keep add-on publishing constraints and `config.yaml` image contract intact.
