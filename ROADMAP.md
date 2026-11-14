# Roadmap

This roadmap covers November 2026 to November 2027. It lists planned work and what is out of scope. The maintainer reviews it whenever a release is cut and at least every six months. Proposals to change it start as an issue; see [governance](GOVERNANCE.md).

## Direction

Meitheal stays a Home Assistant-native, local-first task manager for households. The goal: a household installs Meitheal from the Home Assistant App Store and uses it daily without editing files or reading logs.

## Planned work

### Stable release line

- Keep releases on `0.0.x` (see the version rule in [CONTRIBUTING](CONTRIBUTING.md#submit-a-pull-request)) until the maintainer declares the app production ready, then move to a `0.1` line with documented upgrade steps.
- Meet the [Green benchmark](docs/kcs/green-canary-benchmark.md) and the resource budget in the [release runbook](docs/kcs/releasing.md), and record results from at least one Home Assistant Green or Raspberry Pi device for each Stable release.
- Keep Home Assistant backups and restores lossless across upgrades, with tested database migrations for every schema change.

### Home Assistant integration

- Keep the Ingress and Companion app path working first, including keyboard and screen reader use.
- Mature the optional custom integration: `todo` entities, sensors, services, Assist intents in English and Irish, and device triggers.
- Expose Meitheal tools through Home Assistant's own LLM and MCP interfaces.
- Keep Meitheal's own MCP and A2A endpoints, with a scoped token for each agent.
- Submit the integration to the Home Assistant and HACS catalogues once it meets their quality requirements.

### Planning features

- Give people and AI agents their own identities, task lists, and task-level permissions, with every change attributed to a verified identity.
- Finish the design system on shared, repeatable patterns and remove one-off styling.
- Grow the calendar, recurring routine, and project views without slowing Today or Kanban.
- Add more interface languages through the existing translation catalogues.

### Project health

- Keep no open high or critical alerts from CodeQL, Codacy, dependency review, or Dependabot on `dev`.
- Publish signed build provenance for every Stable image, and keep the [security policy](SECURITY.md) and [assurance case](docs/security-assurance-case.md) current.
- Raise line coverage on Codecov each release, with a regression test for each fixed bug.
- Recruit a second maintainer so the project no longer depends on one person.

## Out of scope

- **No Meitheal cloud.** Household data stays on hardware the household controls. Meitheal will not require an account, a hosted service, or telemetry to work.
- **No separate desktop or mobile apps.** The Home Assistant Companion app and the installable web app cover phones, tablets, and desktops.
- **No enterprise project management.** Meitheal will not add time billing, resource capacity planning, or multi-organisation tenancy.
- **No bundled AI model.** Meitheal connects to the assistants a household already chooses through Home Assistant, MCP, or A2A. It does not ship or host a model.
- **No silent data sharing.** Integrations send data only where an administrator has configured and reviewed the destination.
