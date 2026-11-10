# Meitheal

> The Home Assistant-native execution hub for your house, your homelab, and the plans that keep both moving.

[Install status](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) · [Create your first task](docs/first-task.md) · [Get help](SUPPORT.md)

## What Meitheal Is

Meitheal (pronounced "meh-hal") takes its name from the old Irish idea of neighbors showing up together to get real work done.

That is the product idea here too.

Meitheal started as a task list inside Home Assistant. It has grown into a local-first planner for running a home, a family, or a homelab. Capture tasks, decide what matters now, and connect work to calendars and automations. Keep that context available in the Home Assistant dashboard and companion app.

Meitheal helps answer three questions. What should happen next? Who owns it? What will keep it moving?

## Why It Lives Inside Home Assistant

- It works in the Home Assistant sidebar, companion app, automations, and voice controls.
- It stores your task data locally in SQLite and opens through Home Assistant.
- It can connect work to the rest of the house through to-do lists, calendars, notifications, webhooks, and companion shortcuts.
- It supports both human and agent workflows without asking you to leave your Home Assistant environment.

## What You Can Do With It

### Capture and clarify work

- Capture tasks quickly from the dashboard, Today view, task modal, templates, Assist, or automation flows.
- Use descriptions, checklists, recurrence, labels, due dates, favorites, saved filters, and task links to keep work actionable instead of vague.
- Triage carried-forward work, pin the most important tasks, and surface suggested work for the day.

### Work the way your brain works

- Move between Dashboard, Today, Kanban, Table, Upcoming, Calendar, Projects, Goals, Habits, Pillars, Gamification, Review, Timeline, and Settings.
- Use the shared SearchHub to jump between tasks, views, settings, saved filters, and high-value actions.
- Keep daily work simple when you want it simple, or go deep with strategy lenses, custom fields, rules, and review flows when you want more structure.

### Keep plans connected to the home

- Sync with Home Assistant todo entities and calendar entities.
- Trigger HA automations from task events and push overdue reminders through Home Assistant notifications.
- Bring companion app shortcuts, x-callback-url flows, and installable PWA behavior into the same system.
- Use webhooks to connect task changes to automations you already run.

### Stay available everywhere

- Use the searchable Settings shell to manage integrations, AI, PWA, automation, and system trust surfaces from one place.
- Install it as a PWA, keep working offline, and sync back when connectivity returns.
- Export your data as JSON, CSV, or SQLite, and use built-in backup flows so your planning system stays portable.

### Work with voice and agents

- Use Home Assistant Assist for built-in task actions.
- Expose Meitheal to conversation agents through the Home Assistant LLM API.
- Give external tools a token with only the permissions they need. See the [agent guide](WEBMCP.md).
- Review task changes in Meitheal after you run an automation.

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
4. Add `https://github.com/Coolock-Village/meitheal-ha-addon`.
5. When the image is available, select **Meitheal**.
6. Select **Install**.
7. Select **Start**.
8. Select **Open web UI**.

Earlier Home Assistant versions call Apps **Add-ons**. See the [setup guide](meitheal-hub/DOCS.md) for more detail.

## Try Meitheal from Source

Follow the [local setup](CONTRIBUTING.md#run-and-verify-locally) to open Meitheal in your browser and create a task with a disposable database. Use Home Assistant for voice, companion app, and automation features.

## Voice and AI Quick Start

The optional Home Assistant integration adds voice and conversation-agent controls. Set it up separately after the app is running.

1. Install the [Meitheal integration](docs/kcs/home-assistant-marketplace.md).
2. Open **Settings → Devices & Services** in Home Assistant.
3. Set up the discovered Meitheal entry.
4. Enter a scoped Meitheal token when Home Assistant asks for it.
5. To use voice actions, expose `todo.meitheal_tasks` to Assist.
6. To use a conversation agent, select **Meitheal Tasks** in its settings.

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
- [Use automation with Meitheal](AI_POLICY.md)
- [Community conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)
- [Report a security problem privately](SECURITY.md)

## Legal and Licensing

Meitheal is source-available. Use it at home or inside your organisation. Keep attribution when you share it, and offer changes upstream even if you use them only inside your organisation. The [license](LICENSE) sets the conditions and restrictions on paid copies, access, and services. See [business use](COMMERCIAL.md) for examples. The optional [Home Assistant integration](integrations/home-assistant/LICENSE) and [automation integration](integrations/nodered/LICENSE) have separate licenses. The compatibility API remains separately licensed and outside this release. The [distribution license](https://github.com/Coolock-Village/meitheal-ha-addon/blob/main/LICENSE) covers published add-on images.
