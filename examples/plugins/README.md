# Meitheal Reference Plugins

These folders contain standalone reference plugins for Meitheal. They are not pre-installed in the runtime application. Use them to learn the plugin contract, test ZIP packaging, or start your own extension.

## Included Reference Plugins

| Folder | Plugin ID | Type | Permissions | Purpose |
|--------|-----------|------|-------------|---------|
| `yesterday-carryover/` | `carryover-helper` | `extension` | `tasks:read`, `tasks:write`, `ui:header-button`, `ui:side-panel`, `ui:toast` | Lists overdue and unscheduled tasks in a sandboxed side panel and pulls them into Today. |
| `focus-pulse/` | `focus-pulse` | `extension` | `tasks:read`, `ui:header-button`, `ui:side-panel`, `ui:toast`, `storage:local` | Shows open and completed task counts and saves a daily household focus intention in isolated plugin storage. |

## Package a Reference Plugin

Run the packager script from the repository root:

```bash
node scripts/pack-plugin.mjs examples/plugins/yesterday-carryover
node scripts/pack-plugin.mjs examples/plugins/focus-pulse
```

The command creates a validated `.zip` file next to the plugin folder (or at the path you pass with `--out`):

```bash
node scripts/pack-plugin.mjs examples/plugins/yesterday-carryover --out /tmp/carryover-helper.zip
```

## Install in Meitheal

1. Open **Settings -> Plugins**.
2. Select **Choose Plugin File** and pick the generated `.zip` archive.
3. Open **Details** to inspect declared permissions and local-only isolation.
4. Enable the plugin toggle and check **Plugin Health** to confirm green **Operational** and **Compliant** status.

See `docs/kcs/plugin-development.md` for the full manifest schema, sandbox rules, and submission checklist.
