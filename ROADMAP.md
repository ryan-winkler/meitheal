# Roadmap

This roadmap covers November 2026 to November 2027. It says what Meitheal intends to do and what it deliberately will not do. The maintainer reviews it whenever a release is cut and at least every six months. Proposals to change it start as an issue; see [governance](GOVERNANCE.md).

## Direction

Meitheal stays a Home Assistant-native, local-first task manager for households. Everything below serves one goal: installing Meitheal from the Home Assistant App Store and using it every day should be painless.

## What we intend to do

### Reach a dependable first stable line

- Keep releases on `0.0.x` until the maintainer declares the app production ready, then move to a `0.1` line with documented upgrade steps.
- Hold the published memory and response-time budgets on Home Assistant Green and Raspberry Pi class hardware, and qualify each Stable release on that hardware.
- Keep Home Assistant backups and restores lossless across upgrades, with tested database migrations for every schema change.

### Feel native to Home Assistant

- Keep the Ingress and Companion app path working first, including keyboard and screen reader use.
- Mature the optional custom integration: `todo` entities, sensors, services, Assist intents in English and Irish, and device triggers.
- Make Meitheal tools reachable through Home Assistant's own LLM and MCP interfaces and through the Supervisor, as well as Meitheal's own MCP and A2A endpoints, with scoped tokens for every agent.
- Submit the integration to the Home Assistant and HACS catalogues once it meets their quality requirements.

### Plan and follow through

- Give people and AI agents their own identities, task lists, and task-level permissions, with every change attributed to a verified identity.
- Finish the design system on shared, repeatable patterns and remove one-off styling.
- Grow the calendar, recurring routine, and project views without slowing Today or Kanban.
- Add more interface languages through the existing translation catalogues.

### Earn trust as an open project

- Keep CodeQL, Codacy, OpenSSF Scorecard, dependency review, and Dependabot green on the default branch.
- Publish signed build provenance for every release image, and keep the [security policy](SECURITY.md) and [assurance case](docs/security-assurance-case.md) current.
- Raise automated test coverage, with a regression test for each fixed bug.
- Recruit a second maintainer so the project no longer depends on one person.

## What we will not do

- **No Meitheal cloud.** Household data stays on hardware the household controls. Meitheal will not require an account, a hosted service, or telemetry to work.
- **No separate desktop or mobile apps.** The Home Assistant Companion app and the installable web app cover phones, tablets, and desktops.
- **No enterprise project management.** Meitheal will not add time billing, resource capacity planning, or multi-organisation tenancy.
- **No bundled AI model.** Meitheal connects to the assistants a household already chooses through Home Assistant, MCP, or A2A. It does not ship or host a model.
- **No silent data sharing.** Integrations send data only where an administrator has configured and reviewed the destination.
