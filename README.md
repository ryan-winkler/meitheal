# Meitheal

Meitheal is a local task planner for Home Assistant. Use it to share a household checklist, schedule regular maintenance, or create a task when a sensor triggers an automation. It runs in the Home Assistant sidebar and keeps task data in SQLite on your own device.

[![Docker Hub](https://img.shields.io/docker/v/coolockvillage/meitheal-amd64?label=Docker%20Hub&logo=docker)](https://hub.docker.com/r/coolockvillage/meitheal-amd64)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/ryan-winkler/meitheal/badge)](https://scorecard.dev/viewer/?push=main&repo=github.com/ryan-winkler/meitheal)
[![codecov](https://codecov.io/gh/ryan-winkler/meitheal/graph/badge.svg)](https://codecov.io/gh/ryan-winkler/meitheal)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github&logoColor=white)](https://github.com/sponsors/ryan-winkler)
[![Ko-fi](https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/ryanw_eu)
[![Polar Funding](https://polar.sh/embed/bounties.svg?org=Coolock-Village)](https://polar.sh/Coolock-Village)

[Install status](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) · [Create your first task](docs/first-task.md) · [Get help](SUPPORT.md)

## Plan and follow through

- Add a task with a due date, a checklist, or a repeat schedule. Use Today to choose what to do next and Kanban, Table, or Calendar to plan ahead.
- Group work by Area or Project, save filters you use often, and open tasks and views through [Search](docs/kcs/search-hub-guide.md).
- Configure Home Assistant to-do sync, calendar connections, notifications, or webhooks for the work you want to automate.
- Open Meitheal on a phone or [install the web app](docs/kcs/pwa-offline-guide.md). The offline guide lists which views and edits are available without a connection.
- Use [Home Assistant backups](docs/kcs/home-assistant-backup-and-restore.md) or export your tasks as JSON, CSV, or SQLite.

## Ubiquitous Language

Use these terms when you plan work in Meitheal.

| Term | Meaning |
|------|---------|
| Pillar | A permanent, identity-based motivational anchor — the WHY behind Goals and Routines (e.g. Physical Longevity, Financial Independence) |
| Principle | A behavioral boundary within a Pillar — the Non-Negotiable rules (e.g. "No screens after 9 PM") |
| Area | A life or operating domain such as Home, Work, Family, or Homelab |
| Goal | An outcome you are trying to move toward |
| Project | A bounded body of work in service of a goal |
| Task | A concrete unit of work |
| Routine | Repeatable work that spawns routine instances over time |

Some older views and integrations use earlier names. The [glossary](docs/kcs/hierarchy-glossary.md) explains the current model.

## Screenshots

| Dashboard | Work View | Settings |
|-----------|-----------|----------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Work View](docs/screenshots/table.png) | ![Settings](docs/screenshots/settings.png) |

## Quick Install on Home Assistant

Check [installation availability](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) before you start. The store can list Meitheal while image downloads are unavailable.

1. Open **Settings → Apps → Install app** in Home Assistant.
2. Open the menu.
3. Select **Repositories**.
4. Add `https://github.com/ryan-winkler/meitheal-ha-addon`.
5. When the image is available, select **Meitheal Canary**.
6. Select **Install**.
7. Select **Start**.
8. Select **Open web UI**.

Earlier Home Assistant versions call Apps **Add-ons**. See the [Canary setup guide](meitheal-hub-canary/DOCS.md) for more detail.

## Try Meitheal from Source

Follow the [local setup](CONTRIBUTING.md#run-and-verify-locally) to open Meitheal in your browser and create a task with a disposable database. Use Home Assistant for voice, companion app, and automation features.

## Connect Home Assistant Assist

The optional Home Assistant integration adds a to-do entity, task sensors, and actions. Set it up after the app is running.

1. Install the [Meitheal integration](docs/kcs/home-assistant-marketplace.md).
2. Open **Settings → Devices & Services** in Home Assistant.
3. Set up the discovered Meitheal entry.
4. Enter a scoped Meitheal token when Home Assistant asks for it.
5. In **Settings → Voice assistants → Expose**, choose whether Assist can use `todo.meitheal_tasks`. Use a token with **Read Tasks** and **Create & Update Tasks** for voice capture and completion.

On Home Assistant Core 2026.11 or later, an active administrator can enable **Meitheal Tasks (read only)** in a conversation agent's LLM API settings. It searches and looks up tasks. The selected agent receives the task data returned by those tools. External tools can use separate scoped tokens.

[Integration credentials](docs/kcs/home-assistant-core-credentials.md) · [Agent guide](WEBMCP.md)

## Architecture at a Glance

| Layer | Stack |
|-------|-------|
| Runtime | Server-rendered web app in a Home Assistant add-on |
| Persistence | Local SQLite storage |
| Application | Separate domains for tasks, access, strategy, and integrations |
| Interface | Browser and installable web app with Home Assistant navigation |
| Integrations | Home Assistant, calendars, to-do lists, webhooks, and scoped agent access |
| Deployment | Runs on the same system as Home Assistant |

## Documentation Map

- [Create your first task](docs/first-task.md)
- [Set up the add-on](meitheal-hub/DOCS.md)
- [Open Meitheal on a phone](docs/companion-app-setup.md)
- [Install the web app and use it offline](docs/kcs/pwa-offline-guide.md)
- [Find tasks, views, and settings](docs/kcs/search-hub-guide.md)
- [Find setup and troubleshooting guides](docs/index.md)

## Non-Negotiables

- Keep household data local.
- Make the Home Assistant path work first.
- Keep data accessible through backups and exports.
- Update the user guide when the workflow changes.

## Contribute and Get Help

- [Contribute a change](CONTRIBUTING.md)
- [Use automation with Meitheal](docs/kcs/agent-automation-guide.md)
- [Community conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)
- [Report a security problem privately](SECURITY.md)

## Supporting Meitheal

Meitheal is independent and community-driven. Financial support helps fund infrastructure, accessibility testing, hardware qualification, and continuous development:

- [GitHub Sponsors](https://github.com/sponsors/ryan-winkler)
- [Ko-fi](https://ko-fi.com/ryanw_eu)
- [Revolut](https://revolut.me/ryanwi)
- [Polar](https://polar.sh/Coolock-Village)

## Legal and Licensing

Meitheal is source-available. Use it at home or inside your organisation. Keep attribution when you share it, and offer changes upstream even if you use them only inside your organisation. The [license](LICENSE) sets the conditions and restrictions on paid copies, access, and services. See [business use](COMMERCIAL.md) for examples. The optional [Home Assistant integration](integrations/home-assistant/LICENSE) and [automation integration](integrations/nodered/LICENSE) have separate licenses. The compatibility API remains separately licensed and outside this release. The [distribution license](https://github.com/ryan-winkler/meitheal-ha-addon/blob/main/LICENSE) covers published add-on images.
