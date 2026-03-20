# Meitheal Canary

> ⚠️ **This is the bleeding-edge development build.** It auto-updates on every commit to `main` and may be unstable, break, or lose data. For the stable release, install **Meitheal** instead.

## What is Canary?

Meitheal Canary is the development channel for Meitheal. Every commit merged to `main` triggers an automatic build and publish. This gives testers and developers access to the latest features before they're promoted to a stable release.

## Installation

1. Go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add: `https://github.com/Coolock-Village/meitheal-ha-addon`
3. Find **Meitheal Canary** (look for the flask icon 🧪) → Install → Start

## Differences from Stable

| Aspect | Meitheal (Stable) | Meitheal Canary |
|--------|-------------------|-----------------|
| Updates | Manual version releases | Every `main` commit |
| Stability | Tested, verified | May break at any time |
| Version | Semver (0.0.1, 0.1.0) | Commit SHA (abc1234) |
| Stage | `stable` | `experimental` |
| Icon | 👥 (mdi:account-group) | 🧪 (mdi:flask-outline) |

## Reporting Issues

If you find a bug on Canary, check if it also exists on Stable:

- **Canary-only bug**: May already be fixed in the next commit. Wait a day, then report.
- **Both channels**: Report at [GitHub Issues](https://github.com/Coolock-Village/meitheal-ha-addon/issues) with the SHA version from Settings.

## Switching Channels

You cannot run both Stable and Canary simultaneously (same ingress port). To switch:

1. Stop and uninstall the current channel's addon
2. Install the other channel
3. Your data in `/data/meitheal.db` is preserved between channels
