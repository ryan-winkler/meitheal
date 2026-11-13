# Meitheal Canary — Home Assistant Documentation

**Meitheal Canary** (`/meh·hal/`) is the preview channel for Meitheal — letting you test upcoming household task, routine, project, and Home Assistant integration improvements before they are promoted to a tagged Stable release.

Each Canary build is versioned by its exact source commit SHA and runs inside its own isolated Home Assistant App container (`meitheal_canary`).

## When to Choose Canary vs. Stable

| Channel | App Name | Best For | Update Cadence |
|---|---|---|---|
| **Stable** | **Meitheal** | Everyday household production use | Tagged SemVer releases |
| **Canary** | **Meitheal Canary** | Previewing new features and validating fixes early | Commit-stamped preview builds |

## 1. Install Meitheal Canary

1. In Home Assistant, open **Settings → Apps → Install app** (or **Settings → Add-ons → Add-on Store**).
2. Open the top-right **⋮** menu, select **Repositories**, and add `https://github.com/ryan-winkler/meitheal-ha-addon`.
3. Select **Meitheal Canary**, then select **Install** and **Start**.
4. Enable **Show in sidebar** if you want quick access, then select **Open web UI**.
5. Add a test task in **Today**, refresh the page, and confirm the task persists cleanly.

Check [install status (#1)](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) if an image is mid-rollout.

## 2. Protecting Your Data Across Updates

- **Same-channel updates preserve `/data/meitheal.db`**: Updating **Meitheal Canary** in place keeps your existing SQLite database and settings.
- **Switching channels or repository URLs uses a separate data directory**: Always create a Home Assistant backup that includes **Meitheal Canary** (or export JSON/SQLite from **Settings**) before uninstalling, changing repository URLs, or moving between Canary and Stable.
- **Home Assistant Core integration tokens**: If you connect the separate Meitheal Core custom component in **Settings → Devices & Services**, pause automatic updates before updating, verify your scoped **Agent Token** under **Settings → Automation & AI**, and confirm `todo.meitheal_tasks` and task actions respond after updating.

## 3. Share Feedback or Report an Issue

When reporting something you found on Canary, include:

1. The **Canary commit version** shown on the Home Assistant App **Info** tab.
2. Your **Home Assistant Core** and **Supervisor** versions.
3. The steps you took, what you expected, and what happened (strip any access tokens or personal household details from logs and screenshots).

Open an issue at [github.com/ryan-winkler/meitheal-ha-addon/issues](https://github.com/ryan-winkler/meitheal-ha-addon/issues).
